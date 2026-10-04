create table merlin.source_adapter (
  id text primary key,
  display_name text not null,
  version text not null,
  extensions text[] not null,
  mime_types text[] not null,
  capabilities text[] not null,
  config_schema jsonb,
  updated_at timestamptz not null default now()
);

comment on table merlin.source_adapter is e''
  'The source formats installed ingest workers can read, upserted by each worker at startup from the adapters on its '
  'classpath. What the UI lists as importable formats; merlin.source_revision.adapter names one of these ids (or auto).';
comment on column merlin.source_adapter.capabilities is e''
  'What the adapter produces: resources, activities.';
comment on column merlin.source_adapter.config_schema is e''
  'A JSON Schema for merlin.source_revision.adapter_config, or null when the adapter takes no config.';
