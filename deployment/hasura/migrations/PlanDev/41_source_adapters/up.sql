-- Format plugins: the installed-adapter catalog, per-revision adapter config, and adapter 'auto'.
-- See postgres-init-db for the same definitions.

alter table merlin.source_revision
  alter column adapter set default 'auto',
  add column adapter_config jsonb;

comment on column merlin.source_revision.adapter is e''
  'The id of the adapter that reads the file (see merlin.source_adapter), or ''auto'' to let the worker probe every '
  'installed adapter and use the one that recognizes it. The worker replaces ''auto'' with the id it chose.';
comment on column merlin.source_revision.adapter_config is e''
  'Options for the adapter (a JSON document its config_schema describes), or null. Kept so the import is reproducible.';
comment on column merlin.source_revision.metadata is e''
  'Free metadata. The ingest writes metadata.product from what the adapter reports about the upstream product: '
  '{generatedAt?, productVersion?, suggestedName?, mission?}.';

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

call migrations.mark_migration_applied(41);
