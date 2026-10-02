drop table ui.analysis;
drop view merlin.analysis_activity;

-- Published revisions keep their resources; their activities go with these tables.
drop function merlin.source_activities_in_window(integer, timestamptz, timestamptz);
drop table merlin.source_activity_type;
drop table merlin.source_activity;
do $$
declare t regclass;
begin
  for t in select c.oid::regclass from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = 'merlin' and c.relname ~ '^source_activity_\d+_\d+$' loop
    execute format('drop table if exists %s', t);
  end loop;
end$$;

create or replace function merlin.source_storage_tables(revision_id integer)
  returns table (name regclass, attempt integer)
  language sql stable as $$
  select c.oid::regclass, (regexp_match(c.relname, format('^source_(?:chunk|summary|resort)_%s_(\d+)', revision_id)))[1]::integer
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'merlin' and c.relkind in ('r', 'p')
     and c.relname ~ format('^source_(chunk|summary|resort)_%s_\d+', revision_id)
$$;

create or replace function merlin.source_storage_begin(revision_id integer, attempt integer)
  returns void
  security definer
  language plpgsql as $$
declare
  t regclass;
  timeout text := current_setting('lock_timeout');
begin
  perform merlin.source_ingest_lease(revision_id, attempt);
  -- Drop what earlier attempts left behind. One that is stalled, not dead, still holds its tables: skip
  -- them rather than wait; that worker drops them when it finds it lost the lease.
  perform set_config('lock_timeout', '100ms', true);
  for t in select s.name from merlin.source_storage_tables(revision_id) s where s.attempt <> source_storage_begin.attempt loop
    begin
      execute format('drop table if exists %s', t);
    exception when lock_not_available then null;
    end;
  end loop;
  perform set_config('lock_timeout', timeout, true);
  execute format('create table merlin.source_chunk_%s_%s (like merlin.source_chunk)', revision_id, attempt);
  execute format('create unlogged table merlin.source_summary_%s_%s_staging (like merlin.source_summary)',
    revision_id, attempt);
end$$;

create or replace function merlin.source_storage_publish(revision_id integer, attempt integer, kept_levels jsonb)
  returns void
  security definer
  language plpgsql as $$
declare
  suffix text := format('%s_%s', revision_id, attempt);
begin
  perform merlin.source_ingest_lease(revision_id, attempt);
  execute format('drop table if exists merlin.source_resort_%s', suffix);

  -- Keep only the summary levels the importer chose; the rest were written while it could not yet know.
  execute format('create table merlin.source_summary_%s (like merlin.source_summary)', suffix);
  execute format(
    'insert into merlin.source_summary_%1$s select s.* from merlin.source_summary_%1$s_staging s '
    'join jsonb_to_recordset($1) k(resource_id integer, level smallint) using (resource_id, level)',
    suffix) using kept_levels;
  execute format('drop table merlin.source_summary_%s_staging', suffix);

  execute format('create index on merlin.source_chunk_%s (resource_id, t1)', suffix);
  execute format('create index on merlin.source_summary_%s (resource_id, level, bucket)', suffix);
  -- A matching check constraint lets attach skip scanning the tables.
  execute format('alter table merlin.source_chunk_%1$s add constraint source_chunk_%1$s_revision '
    'check (revision_id = %2$s)', suffix, revision_id);
  execute format('alter table merlin.source_summary_%1$s add constraint source_summary_%1$s_revision '
    'check (revision_id = %2$s)', suffix, revision_id);
  execute format('alter table merlin.source_chunk attach partition merlin.source_chunk_%s '
    'for values in (%s)', suffix, revision_id);
  execute format('alter table merlin.source_summary attach partition merlin.source_summary_%s '
    'for values in (%s)', suffix, revision_id);
end$$;

call migrations.mark_migration_rolled_back(40);
