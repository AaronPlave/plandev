-- merlin.delete_partitions() dropped partitions by unqualified name, so the drops only found the
-- partitions when `merlin` was on the caller's search_path. Otherwise the tables leaked silently
-- ("does not exist, skipping"). Partitions are created as merlin.<table>_<id>; drop them by that name.
create or replace function merlin.delete_partitions()
returns trigger
security definer
language plpgsql as $$begin
  execute 'drop table if exists merlin.profile_segment_' || old.id || ' cascade';
  execute 'drop table if exists merlin.span_' || old.id || ' cascade';
  execute 'drop table if exists merlin.event_' || old.id || ' cascade';
return old;
end$$;

call migrations.mark_migration_applied(38);
