-- Dropping a revision drops its storage tables (trigger drop_source_revision_storage), so delete the
-- revisions first, then the tables and functions.
delete from merlin.source_revision;

drop function merlin.source_storage_discard(integer);
drop function merlin.source_storage_publish(integer, jsonb);
drop function merlin.source_storage_resort_table(integer);
drop function merlin.source_storage_begin(integer);
drop trigger drop_source_revision_storage on merlin.source_revision;
drop function merlin.drop_source_revision_storage();
drop table merlin.source_summary;
drop table merlin.source_chunk;

drop table merlin.plan_source;
drop table merlin.source_resource;
drop trigger notify_source_revision_pending on merlin.source_revision;
drop function merlin.notify_source_revision_pending();
drop table merlin.source_revision;
drop table merlin.source;

call migrations.mark_migration_rolled_back(39);
