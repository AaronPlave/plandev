create table ui.analysis (
  id integer generated always as identity,
  name text not null,
  owner text references permissions.users (username)
    on update cascade
    on delete set null,
  definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint analysis_primary_key primary key (id)
);

comment on table ui.analysis is e''
  'A standalone workspace for inspecting data from several sources, with no plan of its own.';
comment on column ui.analysis.definition is e''
  'The sources it composes (imported revisions, simulation datasets of any plan) and its timeline view state. '
  'Sources are referenced, never copied.';

create trigger set_timestamp
before update on ui.analysis
for each row
execute function util_functions.set_updated_at();
