drop table merlin.source_adapter;

comment on column merlin.source_revision.metadata is null;
comment on column merlin.source_revision.adapter is null;
alter table merlin.source_revision
  drop column adapter_config,
  alter column adapter drop default;

call migrations.mark_migration_rolled_back(41);
