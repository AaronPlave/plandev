create or replace function merlin.delete_partitions()
returns trigger
security definer
language plpgsql as $$begin
  execute 'drop table if exists profile_segment_' || old.id || ' cascade';
  execute 'drop table if exists span_' || old.id || ' cascade';
  execute 'drop table if exists event_' || old.id || ' cascade';
return old;
end$$;

call migrations.mark_migration_rolled_back(38);
