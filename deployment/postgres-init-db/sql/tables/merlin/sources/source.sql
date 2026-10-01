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
  'Refreshed by the ingesting worker. A stale heartbeat on an incomplete revision means the worker died; '
  'another worker may reclaim it and restart the ingest from scratch.';

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
