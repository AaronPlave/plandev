-- Analysis workspace spike: imported activities, one browsing shape for analysis activities, and the
-- analysis itself. See postgres-init-db for the same definitions.

-- Activities of an imported revision: timed instances with a type, a name and the product's own metadata.
--
--   source_activity        one activity instance (a TOL ACT_START/ACT_END pair); partitioned by revision
--   source_activity_type   the revision's activity types with instance counts, written when it is published
--
-- Like resource storage, each ingest attempt loads activities into a standalone table of its own
-- (source_activity_<revision>_<attempt>), attached as the revision's partition on publish.

create table merlin.source_activity (
  revision_id integer not null,
  id integer not null,

  source_key text not null,
  type text not null,
  name text not null,
  category text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  attributes jsonb not null default '{}'::jsonb,
  parameters jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  constraint source_activity_natural_key
    primary key (revision_id, id)
) partition by list (revision_id);

comment on table merlin.source_activity is e''
  'One activity instance of an imported revision. Read-only once published. A revision''s activities are an '
  'ordinary indexed table, not a time-series store: products carry up to about a million of them.';
comment on column merlin.source_activity.id is e''
  'Unique within the revision, in file order. With revision_id, the identity timeline selections refer to.';
comment on column merlin.source_activity.source_key is e''
  'The product''s own identifier for the instance (a TOL Instance ID), kept for provenance.';
comment on column merlin.source_activity.category is e''
  'The source-native grouping, such as a TOL activity''s subsystem attribute.';
comment on column merlin.source_activity.end_time is e''
  'For a TOL, start plus its span attribute; without one, the time of its ACT_END record, else the start. '
  '(TOL ACT_END records often carry the time they were written, not the end; it is kept in metadata.actEnd.)';
comment on column merlin.source_activity.attributes is e''
  'The product''s per-instance attributes (for a TOL: Color, legend, plan, subsystem, span, start), as JSON values.';
comment on column merlin.source_activity.parameters is e''
  'The instance''s parameters as JSON values: lists become arrays, structs objects, durations milliseconds.';
comment on column merlin.source_activity.metadata is e''
  'Provenance the product records about the instance (for a TOL: Parent, Visibility, and the ACT_END time).';

create table merlin.source_activity_type (
  revision_id integer not null,
  type text not null,
  count integer not null,
  category text,
  first_start timestamptz,
  last_end timestamptz,
  parameters jsonb not null default '{}'::jsonb,

  constraint source_activity_type_natural_key
    primary key (revision_id, type),
  constraint source_activity_type_revision_exists
    foreign key (revision_id)
    references merlin.source_revision
    on update cascade
    on delete cascade
);

comment on table merlin.source_activity_type is e''
  'The activity types present in a published revision, with how many instances each has and their most '
  'common category, so a source can be browsed without reading its activities.';
comment on column merlin.source_activity_type.parameters is e''
  'Each parameter name seen on the type''s activities, with the JSON type of its values (the most common one '
  'when they differ): number, string, boolean, array or object. Imported types declare no parameters of their '
  'own, so this is what filters offer for them.';


-- Storage functions now also load, index, catalog and attach a revision's activities.

create or replace function merlin.source_storage_tables(revision_id integer)
  returns table (name regclass, attempt integer)
  language sql stable as $$
  select c.oid::regclass,
         (regexp_match(c.relname, format('^source_(?:chunk|summary|resort|activity)_%s_(\d+)', revision_id)))[1]::integer
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'merlin' and c.relkind in ('r', 'p')
     and c.relname ~ format('^source_(chunk|summary|resort|activity)_%s_\d+', revision_id)
$$;
comment on function merlin.source_storage_tables is e''
  'Every storage table any ingest attempt of a revision has created, with the attempt that created it.';

create or replace function merlin.source_storage_begin(revision_id integer, attempt integer)
  returns void
  security definer
  language plpgsql as $$
declare
  t regclass;
  timeout text := current_setting('lock_timeout');
begin
  perform merlin.source_ingest_lease(revision_id, attempt);
  -- Drop what earlier attempts left behind. One that is stalled, not dead, still holds its tables: skip
  -- them rather than wait; that worker drops them when it finds it lost the lease.
  perform set_config('lock_timeout', '100ms', true);
  for t in select s.name from merlin.source_storage_tables(revision_id) s where s.attempt <> source_storage_begin.attempt loop
    begin
      execute format('drop table if exists %s', t);
    exception when lock_not_available then null;
    end;
  end loop;
  perform set_config('lock_timeout', timeout, true);
  execute format('create table merlin.source_chunk_%s_%s (like merlin.source_chunk)', revision_id, attempt);
  execute format('create unlogged table merlin.source_summary_%s_%s_staging (like merlin.source_summary)',
    revision_id, attempt);
  execute format('create table merlin.source_activity_%s_%s (like merlin.source_activity)', revision_id, attempt);
end$$;
comment on function merlin.source_storage_begin is e''
  'Creates the standalone tables an ingest attempt loads into. They become partitions on publish.';

create or replace function merlin.source_storage_publish(revision_id integer, attempt integer, kept_levels jsonb)
  returns void
  security definer
  language plpgsql as $$
declare
  suffix text := format('%s_%s', revision_id, attempt);
begin
  perform merlin.source_ingest_lease(revision_id, attempt);
  execute format('drop table if exists merlin.source_resort_%s', suffix);

  -- Keep only the summary levels the importer chose; the rest were written while it could not yet know.
  execute format('create table merlin.source_summary_%s (like merlin.source_summary)', suffix);
  execute format(
    'insert into merlin.source_summary_%1$s select s.* from merlin.source_summary_%1$s_staging s '
    'join jsonb_to_recordset($1) k(resource_id integer, level smallint) using (resource_id, level)',
    suffix) using kept_levels;
  execute format('drop table merlin.source_summary_%s_staging', suffix);

  execute format('create index on merlin.source_chunk_%s (resource_id, t1)', suffix);
  execute format('create index on merlin.source_summary_%s (resource_id, level, bucket)', suffix);
  -- A matching check constraint lets attach skip scanning the tables.
  execute format('alter table merlin.source_chunk_%1$s add constraint source_chunk_%1$s_revision '
    'check (revision_id = %2$s)', suffix, revision_id);
  execute format('alter table merlin.source_summary_%1$s add constraint source_summary_%1$s_revision '
    'check (revision_id = %2$s)', suffix, revision_id);
  execute format('alter table merlin.source_chunk attach partition merlin.source_chunk_%s '
    'for values in (%s)', suffix, revision_id);
  execute format('alter table merlin.source_summary attach partition merlin.source_summary_%s '
    'for values in (%s)', suffix, revision_id);

  -- Activities, and the revision's activity type catalog.
  execute format('create index on merlin.source_activity_%s (start_time)', suffix);
  execute format('create index on merlin.source_activity_%s (type, start_time)', suffix);
  execute format('alter table merlin.source_activity_%1$s add constraint source_activity_%1$s_revision '
    'check (revision_id = %2$s)', suffix, revision_id);
  execute format('alter table merlin.source_activity attach partition merlin.source_activity_%s '
    'for values in (%s)', suffix, revision_id);
  execute format('insert into merlin.source_activity_type '
    '(revision_id, type, count, category, first_start, last_end, parameters) '
    'select %2$s, a.type, count(*), mode() within group (order by a.category), min(a.start_time), max(a.end_time), '
    '  coalesce(p.parameters, ''{}'') '
    'from merlin.source_activity_%1$s a left join ('
    '  select type, jsonb_object_agg(name, value_type) parameters from ('
    '    select type, e.key name, mode() within group (order by jsonb_typeof(e.value)) value_type '
    '    from merlin.source_activity_%1$s, jsonb_each(parameters) e '
    '    where jsonb_typeof(e.value) <> ''null'' group by type, e.key) t '
    '  group by type) p using (type) '
    'group by a.type, p.parameters', suffix, revision_id);
  -- Statistics for the planner, which otherwise misjudges reads of a freshly loaded revision.
  execute format('analyze merlin.source_activity_%s', suffix);
end$$;
comment on function merlin.source_storage_publish is e''
  'Indexes an attempt''s loaded tables, writes the activity type catalog and attaches the tables, making the '
  'revision''s data readable. The caller '
  'marks the revision successful in the same transaction, which still holds the lease this took.';

create view merlin.analysis_activity as
(
  select 'revision'::text as source_kind,
         a.revision_id as source_ref,
         a.id as activity_id,
         a.type,
         a.name,
         a.category,
         a.start_time,
         a.end_time
    from merlin.source_activity a
  union all
  select 'simulation'::text,
         sd.id,
         span.span_id,
         span.type,
         coalesce(directive.name, span.type),
         null::text,
         sd.simulation_start_time + span.start_offset,
         sd.simulation_start_time + span.start_offset + coalesce(span.duration, interval '0')
    from merlin.simulation_dataset sd
    join merlin.span span on span.dataset_id = sd.dataset_id
    join merlin.simulation sim on sim.id = sd.simulation_id
    left join merlin.activity_directive directive
      on directive.plan_id = sim.plan_id and directive.id = (span.attributes#>>'{directiveId}')::integer
);

comment on view merlin.analysis_activity is e''
  'Activities from the kinds of source an analysis can compose, in one shape for browsing: an imported '
  'revision''s activities (source_kind revision, source_ref the revision id) and a simulation dataset''s spans '
  '(source_kind simulation, source_ref the simulation dataset id). (source_kind, source_ref, activity_id) '
  'identifies an activity; details stay in source_activity and span.';
comment on column merlin.analysis_activity.name is e''
  'An imported activity''s own name; for a span, the current name of the directive it came from, else its type.';

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

call migrations.mark_migration_applied(40);
