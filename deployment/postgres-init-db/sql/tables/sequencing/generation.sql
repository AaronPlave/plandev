create table sequencing.generation (
  id integer generated always as identity,

  plan_id integer not null,
  simulation_dataset_id integer null,
  requested_seq_id text not null,

  status util_functions.request_status not null default 'pending',

  requested_by text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz null,

  request_snapshot jsonb not null,
  source_snapshot jsonb null,
  expansion_snapshot jsonb null,
  diagnostics jsonb not null default '[]'::jsonb,
  error jsonb null,

  constraint generation_synthetic_key
    primary key (id),
  constraint generation_plan_exists
    foreign key (plan_id)
    references merlin.plan
    on update cascade
    on delete cascade,
  constraint generation_simulation_dataset_exists
    foreign key (simulation_dataset_id)
    references merlin.simulation_dataset
    on update cascade
    on delete set null,
  constraint generation_requested_by_exists
    foreign key (requested_by)
    references permissions.users
    on update cascade
    on delete set null,
  constraint generation_completed_when_terminal
    check ((status in ('success', 'failed')) = (completed_at is not null))
);

create index generation_plan_id_index on sequencing.generation (plan_id);
create index generation_simulation_dataset_id_index on sequencing.generation (simulation_dataset_id);

comment on table sequencing.generation is e''
  'One immutable attempt to generate sequence products from one resolved set of inputs.\n'
  'A retry or regeneration always creates a new generation; a finished generation is never modified.';
comment on column sequencing.generation.id is e''
  'The unique identifier of this generation.';
comment on column sequencing.generation.plan_id is e''
  'The plan whose simulated activities this generation was requested against.';
comment on column sequencing.generation.simulation_dataset_id is e''
  'The simulation dataset that was resolved as the source of this generation, if any.\n'
  'Set to null if the dataset is later deleted; the source snapshot still records it.';
comment on column sequencing.generation.requested_seq_id is e''
  'The sequence id (mission/export identifier) the user requested. This is not the identity of the generated product.';
comment on column sequencing.generation.status is e''
  'The state of this generation: pending, incomplete (running), success or failed.';
comment on column sequencing.generation.requested_by is e''
  'The user who requested this generation.';
comment on column sequencing.generation.requested_at is e''
  'When this generation was requested.';
comment on column sequencing.generation.completed_at is e''
  'When this generation reached a terminal status (success or failed).';
comment on column sequencing.generation.request_snapshot is e''
  'The user intent: selection (activities or filter), sequence id and metadata, exactly as requested.';
comment on column sequencing.generation.source_snapshot is e''
  'The resolved source: source type, identifiers, revisions and the exact source activities used.\n'
  'Structured so that sources other than a native PlanDev simulation can be represented later.';
comment on column sequencing.generation.expansion_snapshot is e''
  'The resolved expansion environment: mission model, parcels, dictionaries, sequence adaptation,\n'
  'the full contents and hashes of the sequence templates used, and the generator version.';
comment on column sequencing.generation.diagnostics is e''
  'Structured diagnostics (errors, warnings) produced while resolving and expanding this generation.';
comment on column sequencing.generation.error is e''
  'A summary of why this generation failed, if it failed.';

create function sequencing.generation_immutable()
  returns trigger
  language plpgsql as $$
begin
  if old.status in ('success', 'failed') then
    -- The only permitted change to a finished generation is its simulation dataset reference
    -- being nulled out when that dataset is deleted.
    if new.simulation_dataset_id is null
      and (to_jsonb(new) - 'simulation_dataset_id') = (to_jsonb(old) - 'simulation_dataset_id')
    then
      return new;
    end if;
    raise exception 'Generation % is % and cannot be modified. Create a new generation instead.', old.id, old.status;
  end if;
  if new.request_snapshot is distinct from old.request_snapshot
    or new.plan_id is distinct from old.plan_id
    or new.requested_seq_id is distinct from old.requested_seq_id
    or new.requested_by is distinct from old.requested_by
    or new.requested_at is distinct from old.requested_at
  then
    raise exception 'The request of generation % cannot be modified.', old.id;
  end if;
  return new;
end
$$;

comment on function sequencing.generation_immutable() is e''
  'Prevents finished generations, and the request of any generation, from being modified.';

create trigger generation_immutable_trigger
  before update on sequencing.generation
  for each row
  execute function sequencing.generation_immutable();
