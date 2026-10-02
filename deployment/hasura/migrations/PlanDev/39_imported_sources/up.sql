-- Imported sources: see tables/merlin/sources/ in postgres-init-db for the commented definitions.

-- Imported sources: immutable data products (a TOL, a KPT, ...) that exist independently of any plan.
--
--   source            a stable logical product (e.g. "mission tour TOL")
--   source_revision   one immutable import of it; its data lives in a storage provider (storage_kind)
--   source_resource   the revision's resource catalog, browseable without reading its data
--   plan_source       an optional use of one revision by one plan

create table merlin.source (
  id integer generated always as identity,
  name text not null,
  source_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  owner text,
  created_at timestamptz not null default now(),

  constraint source_synthetic_key
    primary key (id),
  constraint source_owner_exists
    foreign key (owner)
    references permissions.users
    on update cascade
    on delete set null
);

comment on table merlin.source is e''
  'A stable, logical imported data product. Its contents are its revisions.';
comment on column merlin.source.source_type is e''
  'The kind of product, e.g. "xml_tol". Informational; each revision names the adapter that read it.';

create table merlin.source_revision (
  id integer generated always as identity,
  source_id integer not null,

  status util_functions.request_status not null default 'pending',
  canceled boolean not null default false,
  error jsonb,
  progress jsonb not null default '{}'::jsonb,

  adapter text not null,
  adapter_version text,
  original_file_id integer,
  original_path text,
  content_hash text,

  coverage_start timestamptz,
  coverage_end timestamptz,

  storage_kind text not null,
  storage_key jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  requested_by text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  ingest_attempt integer not null default 0,

  constraint source_revision_synthetic_key
    primary key (id),
  constraint source_revision_source_exists
    foreign key (source_id)
    references merlin.source
    on update cascade
    on delete cascade,
  constraint source_revision_file_exists
    foreign key (original_file_id)
    references merlin.uploaded_file
    on update cascade
    on delete set null,
  constraint source_revision_requester_exists
    foreign key (requested_by)
    references permissions.users
    on update cascade
    on delete set null,
  constraint source_revision_has_input
    check (original_file_id is not null or original_path is not null)
);

create index source_revision_pending on merlin.source_revision (requested_at) where status = 'pending';

comment on table merlin.source_revision is e''
  'One immutable import of a source. It is also the ingest job: status, progress and heartbeat_at are written by '
  'the worker that claims it, and its data becomes visible only when status reaches ''success''.';
comment on column merlin.source_revision.status is e''
  'pending: waiting for a worker. incomplete: being ingested. success: published and immutable. failed: see error.';
comment on column merlin.source_revision.original_path is e''
  'A file already on the server, for inputs too large to upload through the gateway.';
comment on column merlin.source_revision.storage_kind is e''
  'Which storage provider holds the data, e.g. "pg_chunks_v1". Readers dispatch on it; '
  'nothing outside the provider may depend on its physical layout.';
comment on column merlin.source_revision.storage_key is e''
  'Provider-specific location of the data. Never persisted outside the database (e.g. in views).';
comment on column merlin.source_revision.heartbeat_at is e''
  'Refreshed by the ingesting worker. A stale heartbeat on an incomplete revision means the worker died or '
  'stalled; another worker may reclaim it and restart the ingest from scratch.';
comment on column merlin.source_revision.ingest_attempt is e''
  'Incremented by every claim: the lease. Each write an ingest makes to the revision, its catalog or its storage '
  'requires the attempt it claimed to still be current, so a stalled worker that was reclaimed can change nothing.';

create function merlin.notify_source_revision_pending()
  returns trigger
  security definer
  language plpgsql as $$
begin
  perform pg_notify('source_revision_pending', new.id::text);
  return null;
end$$;

create trigger notify_source_revision_pending
  after insert on merlin.source_revision
  for each row
  when (new.status = 'pending')
  execute function merlin.notify_source_revision_pending();

create table merlin.source_resource (
  revision_id integer not null,
  id integer not null,

  key text not null,
  name text not null,
  index text[] not null default '{}',
  category text,
  data_type text not null,
  numeric boolean not null,
  interpolation text not null,
  units text,
  schema jsonb not null,
  metadata jsonb not null default '{}'::jsonb,

  sample_count bigint,
  coverage_start timestamptz,
  coverage_end timestamptz,
  value_min double precision,
  value_max double precision,
  storage jsonb not null default '{}'::jsonb,

  constraint source_resource_natural_key
    primary key (revision_id, id),
  constraint source_resource_unique_key
    unique (revision_id, key),
  constraint source_resource_revision_exists
    foreign key (revision_id)
    references merlin.source_revision
    on update cascade
    on delete cascade,
  constraint source_resource_interpolation
    check (interpolation in ('linear', 'constant'))
);

comment on table merlin.source_resource is e''
  'The resource catalog of a revision. Written from the file''s manifest before any data is read, so a source can '
  'be browsed while it ingests; sample_count, coverage and value bounds are filled in when ingest completes.';
comment on column merlin.source_resource.key is e''
  'Unique within the revision, and what timeline layers refer to. For a TOL: Name[Index0][Index1]...';
comment on column merlin.source_resource.schema is e''
  'A PlanDev value schema, so the timeline renders the resource like any other.';
comment on column merlin.source_resource.interpolation is e''
  'How to draw between samples: linear, or constant (hold the value until the next sample).';
comment on column merlin.source_resource.storage is e''
  'Provider-specific per-resource details (e.g. which summary levels exist).';

create table merlin.plan_source (
  id integer generated always as identity,
  plan_id integer not null,
  source_revision_id integer not null,
  label text,
  created_by text,
  created_at timestamptz not null default now(),

  constraint plan_source_synthetic_key
    primary key (id),
  constraint plan_source_unique
    unique (plan_id, source_revision_id),
  constraint plan_source_plan_exists
    foreign key (plan_id)
    references merlin.plan
    on update cascade
    on delete cascade,
  constraint plan_source_revision_exists
    foreign key (source_revision_id)
    references merlin.source_revision
    on update cascade
    on delete cascade,
  constraint plan_source_creator_exists
    foreign key (created_by)
    references permissions.users
    on update cascade
    on delete set null
);

comment on table merlin.plan_source is e''
  'A plan''s use of one source revision. Its id is the stable identity timeline layers bind to '
  '("imported:<id>"). Deleting it never deletes the revision or its data.';

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
  '(listed in source_resource.storage). min/max cover values only, not nulls or gaps. Besides its first and '
  'last samples, a bucket records the internal samples a display needs so that nothing visible inside it is '
  'lost: the first null or gap, and (discrete resources) the first change of state.';
comment on column merlin.source_summary.nonvalue_t is e''
  'The first sample after the bucket''s first whose kind is a null or a gap (nonvalue_kind), so a line '
  'drawn through the bucket breaks where the data does.';
comment on column merlin.source_summary.change_t is e''
  'Discrete resources: the first sample after the bucket''s first that differs from the sample before it '
  '(change_kind, change_s), so a state held more briefly than the bucket still shows.';

-- Each ingest attempt loads into its own standalone tables, named source_<chunk|summary>_<revision>_<attempt>.
-- A worker that was reclaimed while stalled can therefore only ever write to its own tables, which nothing
-- reads, and the attempt that publishes attaches its tables as the revision's partitions.

create function merlin.source_storage_tables(revision_id integer)
  returns table (name regclass, attempt integer)
  language sql stable as $$
  select c.oid::regclass, (regexp_match(c.relname, format('^source_(?:chunk|summary|resort)_%s_(\d+)', revision_id)))[1]::integer
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'merlin' and c.relkind in ('r', 'p')
     and c.relname ~ format('^source_(chunk|summary|resort)_%s_\d+', revision_id)
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
end$$;

comment on function merlin.source_storage_publish is e''
  'Indexes an attempt''s loaded tables and attaches them, making the revision''s data readable. The caller '
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

call migrations.mark_migration_applied(39);
