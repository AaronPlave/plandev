-- SPIKE (standalone timeline datasets): provisional terminology and shape.
-- A thin wrapper that lets a merlin.dataset exist without a Plan, mission model, or simulation,
-- and gives it the absolute time basis that is otherwise derived from plan.start_time.
create table merlin.standalone_dataset (
  id integer generated always as identity,
  name text not null,
  dataset_id integer not null,
  start_time timestamptz not null,
  end_time timestamptz not null,

  constraint standalone_dataset_synthetic_key
    primary key (id),
  constraint standalone_dataset_owns_one_dataset
    unique (dataset_id),
  constraint standalone_dataset_references_dataset
    foreign key (dataset_id)
    references merlin.dataset
    on update cascade
    on delete cascade,
  constraint standalone_dataset_end_after_start
    check (end_time >= start_time)
);

comment on table merlin.standalone_dataset is e''
  'SPIKE: A dataset that exists independently of any plan or simulation.'
'\n'
  'The wrapper owns its merlin.dataset: deleting the wrapper deletes the dataset.';
comment on column merlin.standalone_dataset.id is e''
  'The synthetic identifier for this standalone dataset.';
comment on column merlin.standalone_dataset.name is e''
  'A human-readable name for this standalone dataset.';
comment on column merlin.standalone_dataset.dataset_id is e''
  'The dataset owned by this wrapper. Allocated automatically on insert if not provided.';
comment on column merlin.standalone_dataset.start_time is e''
  'The absolute time that profile and span start_offsets in the dataset are relative to.';
comment on column merlin.standalone_dataset.end_time is e''
  'The absolute end of the time range covered by this dataset.';

-- If no dataset is provided, allocate one (mirrors simulation_dataset / plan_dataset).
-- If one is provided, refuse to adopt a dataset another owner will also try to delete.
create function merlin.standalone_dataset_initialize_dataset()
returns trigger
security definer
language plpgsql as $$
begin
  if new.dataset_id is null then
    insert into merlin.dataset
    default values
    returning id into new.dataset_id;
  elsif exists(select from merlin.simulation_dataset where dataset_id = new.dataset_id)
     or exists(select from merlin.plan_dataset where dataset_id = new.dataset_id) then
    raise exception 'Dataset % is already owned by a simulation or plan dataset', new.dataset_id;
  end if;
  return new;
end$$;

create trigger standalone_dataset_initialize_dataset_trigger
  before insert on merlin.standalone_dataset
  for each row
  execute function merlin.standalone_dataset_initialize_dataset();

create function merlin.standalone_dataset_prevent_dataset_change()
returns trigger
security invoker
language plpgsql as $$
begin
  raise exception 'Cannot change the dataset owned by a standalone dataset';
end$$;

create trigger standalone_dataset_prevent_dataset_change_trigger
  before update of dataset_id on merlin.standalone_dataset
  for each row
  when (old.dataset_id is distinct from new.dataset_id)
  execute function merlin.standalone_dataset_prevent_dataset_change();

-- Deleting the wrapper deletes the dataset it owns. The FK above covers the other direction
-- (deleting the dataset removes the wrapper); when that happens this trigger's delete finds no row.
create function merlin.standalone_dataset_delete_dataset()
returns trigger
security definer
language plpgsql as $$
begin
  delete from merlin.dataset
  where id = old.dataset_id;
  return old;
end$$;

create trigger standalone_dataset_delete_dataset_trigger
  after delete on merlin.standalone_dataset
  for each row
  execute function merlin.standalone_dataset_delete_dataset();
