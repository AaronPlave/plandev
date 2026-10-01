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
  changes integer not null
) partition by list (revision_id);

comment on table merlin.source_summary is e''
  'The samples of one resource falling in [bucket * width, (bucket + 1) * width), where width is '
  '1 second * 4^level. Only non-empty buckets are stored, and only the levels that reduce the data are kept '
  '(listed in source_resource.storage). min/max cover values only, not nulls or gaps.';
comment on column merlin.source_summary.changes is e''
  'How many samples in the bucket differ from the sample before them. Lets a reader know a discrete resource '
  'changed state inside a bucket that is narrower than a pixel.';

create function merlin.drop_source_revision_storage()
  returns trigger
  security definer
  language plpgsql as $$
begin
  execute format('drop table if exists merlin.source_chunk_%s', old.id);
  execute format('drop table if exists merlin.source_summary_%s', old.id);
  return old;
end$$;

create trigger drop_source_revision_storage
  after delete on merlin.source_revision
  for each row
  execute function merlin.drop_source_revision_storage();

-- The ingest worker connects as the merlin service user, which cannot create tables. These functions
-- do the DDL on its behalf, for one revision at a time, the same way dataset partitions are allocated.

create function merlin.source_storage_begin(revision_id integer)
  returns void
  security definer
  language plpgsql as $$
begin
  if not exists(select from merlin.source_revision r where r.id = revision_id and r.status = 'incomplete') then
    raise exception 'Revision % is not being ingested', revision_id;
  end if;
  -- A reclaimed revision restarts from scratch: discard whatever the previous attempt wrote.
  execute format('drop table if exists merlin.source_chunk_%s', revision_id);
  execute format('drop table if exists merlin.source_summary_%s', revision_id);
  execute format('drop table if exists merlin.source_summary_%s_staging', revision_id);
  execute format('drop table if exists merlin.source_resort_%s', revision_id);
  execute format('create table merlin.source_chunk_%s (like merlin.source_chunk)', revision_id);
  execute format('create unlogged table merlin.source_summary_%s_staging (like merlin.source_summary)', revision_id);
end$$;

comment on function merlin.source_storage_begin is e''
  'Creates the standalone tables a revision is loaded into. They become partitions on publish.';

create function merlin.source_storage_resort_table(revision_id integer)
  returns text
  security definer
  language plpgsql as $$
begin
  execute format('drop table if exists merlin.source_resort_%s', revision_id);
  execute format('create unlogged table merlin.source_resort_%s '
    '(resource_id integer, seq bigint, t bigint, num double precision, txt text, kind smallint)', revision_id);
  return format('merlin.source_resort_%s', revision_id);
end$$;

create function merlin.source_storage_publish(revision_id integer, kept_levels jsonb)
  returns void
  security definer
  language plpgsql as $$
begin
  if not exists(select from merlin.source_revision r where r.id = revision_id and r.status = 'incomplete') then
    raise exception 'Revision % is not being ingested', revision_id;
  end if;
  execute format('drop table if exists merlin.source_resort_%s', revision_id);

  -- Keep only the summary levels the importer chose; the rest were written while it could not yet know.
  execute format('create table merlin.source_summary_%1$s (like merlin.source_summary)', revision_id);
  execute format(
    'insert into merlin.source_summary_%1$s select s.* from merlin.source_summary_%1$s_staging s '
    'join jsonb_to_recordset($1) k(resource_id integer, level smallint) using (resource_id, level)',
    revision_id) using kept_levels;
  execute format('drop table merlin.source_summary_%s_staging', revision_id);

  execute format('create index on merlin.source_chunk_%s (resource_id, t1)', revision_id);
  execute format('create index on merlin.source_summary_%s (resource_id, level, bucket)', revision_id);
  -- A matching check constraint lets attach skip scanning the tables.
  execute format('alter table merlin.source_chunk_%1$s add constraint source_chunk_%1$s_revision '
    'check (revision_id = %1$s)', revision_id);
  execute format('alter table merlin.source_summary_%1$s add constraint source_summary_%1$s_revision '
    'check (revision_id = %1$s)', revision_id);
  execute format('alter table merlin.source_chunk attach partition merlin.source_chunk_%1$s '
    'for values in (%1$s)', revision_id);
  execute format('alter table merlin.source_summary attach partition merlin.source_summary_%1$s '
    'for values in (%1$s)', revision_id);
end$$;

comment on function merlin.source_storage_publish is e''
  'Indexes a loaded revision and attaches it, making its data readable. The caller marks the revision '
  'successful in the same transaction.';

create function merlin.source_storage_discard(revision_id integer)
  returns void
  security definer
  language plpgsql as $$
begin
  execute format('drop table if exists merlin.source_chunk_%s', revision_id);
  execute format('drop table if exists merlin.source_summary_%s', revision_id);
  execute format('drop table if exists merlin.source_summary_%s_staging', revision_id);
  execute format('drop table if exists merlin.source_resort_%s', revision_id);
end$$;
