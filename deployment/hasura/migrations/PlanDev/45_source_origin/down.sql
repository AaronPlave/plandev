drop index merlin.source_origin_unique;
alter table merlin.source drop column origin;

call migrations.mark_migration_rolled_back(45);
