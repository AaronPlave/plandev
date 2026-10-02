-- Storage provider "pg_chunks_v1": dense resource samples in Postgres, packed into chunks, plus a
-- per-resource pyramid of bucket summaries for bounded wide-window reads.
--
-- Both tables are partitioned by revision. The ingest worker loads each revision into standalone
-- tables, indexes them, and attaches them as partitions when the revision is published, so readers
-- never see a partial revision and deleting a revision drops two tables.

create table merlin.source_chunk (
  revision_id integer not null,
  resource_id integer not null,
  t0 bigint not null,
  t1 bigint not null,
  n integer not null,
  times bytea not null,
  nums bytea,
  texts bytea,
  kinds bytea
) partition by list (revision_id);

comment on table merlin.source_chunk is e''
  'Up to a fixed number of consecutive samples of one resource, in time order. Chunks of a resource do not overlap.';
comment on column merlin.source_chunk.t0 is e''
  'Time of the first sample, in microseconds since the Unix epoch.';
comment on column merlin.source_chunk.t1 is e''
  'Time of the last sample, in microseconds since the Unix epoch.';
comment on column merlin.source_chunk.times is e''
  'Sample times: n little-endian float64 values, integer microseconds since the Unix epoch (exact below 2^53).';
comment on column merlin.source_chunk.nums is e''
  'Numeric resources: n little-endian float64 values.';
comment on column merlin.source_chunk.texts is e''
  'Discrete resources: n values, each a little-endian uint32 byte length followed by that many UTF-8 bytes.';
comment on column merlin.source_chunk.kinds is e''
  'One byte per sample (0 value, 1 valid null, 2 gap start), or NULL when every sample is a value.';

create table merlin.source_summary (
  revision_id integer not null,
  resource_id integer not null,
  level smallint not null,
  bucket bigint not null,
  n integer not null,
  first_t bigint not null,
  last_t bigint not null,
  first_kind smallint not null,
  last_kind smallint not null,
  min_t bigint,
  max_t bigint,
  first_v double precision,
  last_v double precision,
  min_v double precision,
  max_v double precision,
  first_s text,
  last_s text,
  nonvalue_t bigint,
  nonvalue_kind smallint,
  change_t bigint,
  change_kind smallint,
  change_s text
) partition by list (revision_id);

comment on table merlin.source_summary is e''
  'The samples of one resource falling in [bucket * width, (bucket + 1) * width), where width is '
  '1 second * 4^level. Only non-empty buckets are stored, and only the levels that reduce the data are kept '
  '(listed in source_resource.storage). min/max cover values only, not nulls or gaps. A bucket keeps '
  'representative samples for display: its first and last, numeric extrema, one internal null or gap, and '
  '(discrete resources) one internal change of state, so short state changes and breaks stay visible in '
  'common cases. Further events within the same bucket may be omitted; exact queries read source_chunk and '
  'remain authoritative.';
comment on column merlin.source_summary.nonvalue_t is e''
  'The first sample after the bucket''s first whose kind is a null or a gap (nonvalue_kind), so a line '
  'drawn through the bucket breaks there. Later nulls or gaps in the same bucket are not recorded.';
comment on column merlin.source_summary.change_t is e''
  'Discrete resources: the first sample after the bucket''s first that differs from the sample before it '
  '(change_kind, change_s), so a state held more briefly than the bucket still shows. Later changes in the '
  'same bucket are not recorded.';

-- Each ingest attempt loads into its own standalone tables, named source_<chunk|summary>_<revision>_<attempt>.
-- A worker that was reclaimed while stalled can therefore only ever write to its own tables, which nothing
-- reads, and the attempt that publishes attaches its tables as the revision's partitions.

create function merlin.source_storage_tables(revision_id integer)
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

create function merlin.source_ingest_lease(revision_id integer, attempt integer)
  returns void
  language plpgsql as $$
begin
  perform from merlin.source_revision r
   where r.id = revision_id and r.status = 'incomplete' and r.ingest_attempt = attempt
     for update;
  if not found then
    raise exception 'Revision % ingest attempt % no longer holds the lease', revision_id, attempt;
  end if;
end$$;

comment on function merlin.source_ingest_lease is e''
  'Locks the revision until the end of the transaction, if `attempt` still holds its ingest lease; raises '
  'otherwise. A worker calls it first in every transaction that writes the revision or its catalog, and the '
  'storage functions call it themselves, so a reclaimed attempt''s late write fails instead of landing.';

create function merlin.drop_source_revision_storage()
  returns trigger
  security definer
  language plpgsql as $$
declare
  t regclass;
begin
  for t in select name from merlin.source_storage_tables(old.id) loop
    execute format('drop table if exists %s', t);
  end loop;
  return old;
end$$;

create trigger drop_source_revision_storage
  after delete on merlin.source_revision
  for each row
  execute function merlin.drop_source_revision_storage();

-- The ingest worker connects as the merlin service user, which cannot create tables. These functions
-- do the DDL on its behalf, for one revision at a time, the same way dataset partitions are allocated.

create function merlin.source_storage_begin(revision_id integer, attempt integer)
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

create function merlin.source_storage_resort_table(revision_id integer, attempt integer)
  returns text
  security definer
  language plpgsql as $$
begin
  perform merlin.source_ingest_lease(revision_id, attempt);
  execute format('drop table if exists merlin.source_resort_%s_%s', revision_id, attempt);
  execute format('create unlogged table merlin.source_resort_%s_%s '
    '(resource_id integer, seq bigint, t bigint, num double precision, txt text, kind smallint)', revision_id, attempt);
  return format('merlin.source_resort_%s_%s', revision_id, attempt);
end$$;

create function merlin.source_storage_publish(revision_id integer, attempt integer, kept_levels jsonb)
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

create function merlin.source_storage_discard(revision_id integer, attempt integer)
  returns void
  security definer
  language plpgsql as $$
declare
  t regclass;
begin
  -- An attempt only ever discards its own tables, and never once they are the published revision.
  if exists(select from merlin.source_revision r
             where r.id = revision_id and r.status = 'success' and r.ingest_attempt = attempt) then
    return;
  end if;
  for t in select s.name from merlin.source_storage_tables(revision_id) s where s.attempt = source_storage_discard.attempt loop
    execute format('drop table if exists %s', t);
  end loop;
end$$;
