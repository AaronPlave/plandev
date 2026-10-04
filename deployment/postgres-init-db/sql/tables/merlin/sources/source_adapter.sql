create table merlin.source_adapter (
  id text primary key,
  display_name text not null,
  version text not null,
  extensions text[] not null,
  mime_types text[] not null,
  capabilities text[] not null,
  config_schema jsonb,
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table merlin.source_adapter is e''
  'Every source format an ingest worker has been able to read, upserted by each worker from the adapters on its '
  'classpath. merlin.source_revision.adapter names one of these ids (or auto). Rows are never removed: old revisions '
  'name the adapters that read them.';
comment on column merlin.source_adapter.last_seen_at is e''
  'When a running worker last reported having this adapter (at startup, after each job, and while idle). An adapter '
  'no worker has reported recently was uninstalled or has no worker running; the UI does not offer it.';
comment on column merlin.source_adapter.capabilities is e''
  'What the adapter produces: resources, activities.';
comment on column merlin.source_adapter.config_schema is e''
  'A JSON Schema for merlin.source_revision.adapter_config, or null when the adapter takes no config.';
