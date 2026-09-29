-- Deleting the wrappers first lets their triggers delete the datasets they own.
delete from merlin.standalone_dataset;

drop trigger standalone_dataset_delete_dataset_trigger on merlin.standalone_dataset;
drop function merlin.standalone_dataset_delete_dataset();
drop trigger standalone_dataset_prevent_dataset_change_trigger on merlin.standalone_dataset;
drop function merlin.standalone_dataset_prevent_dataset_change();
drop trigger standalone_dataset_initialize_dataset_trigger on merlin.standalone_dataset;
drop function merlin.standalone_dataset_initialize_dataset();
drop table merlin.standalone_dataset;

call migrations.mark_migration_rolled_back(38);
