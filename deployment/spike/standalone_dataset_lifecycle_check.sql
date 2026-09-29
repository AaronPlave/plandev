-- SPIKE: psql-only lifecycle checks for merlin.standalone_dataset (mirrors db-tests StandaloneDatasetTests).
-- Runs in a transaction and rolls back, so it is safe against a dev database.
--
--   psql "postgresql://plandev_admin:<password>@localhost:5432/plandev" -v ON_ERROR_STOP=1 \
--     -f deployment/spike/standalone_dataset_lifecycle_check.sql
begin;

-- merlin.delete_partitions() drops partitions by UNQUALIFIED name, so partition cleanup only works when
-- merlin is on the search_path (true for Hasura's connection; not for a default psql session).
-- Pre-existing behavior, also affects simulation datasets. Mimic Hasura here. See SPIKE_FINDINGS.md.
set local search_path = merlin, public;

listen simulation_notification;

do $$
declare
  _sd merlin.standalone_dataset;
  _other merlin.standalone_dataset;
  _plans_before integer := (select count(*) from merlin.plan);
  _sims_before integer := (select count(*) from merlin.simulation_dataset);
  _n integer;
begin
  -- Insert allocates its own dataset + partitions.
  insert into merlin.standalone_dataset (name, start_time, end_time)
  values ('check', '2029-01-01T00:00:00Z', '2029-01-02T00:00:00Z') returning * into _sd;
  insert into merlin.standalone_dataset (name, start_time, end_time)
  values ('other', '2029-01-01T00:00:00Z', '2029-01-02T00:00:00Z') returning * into _other;
  assert exists(select from merlin.dataset where id = _sd.dataset_id), 'dataset allocated';
  assert (select count(*) from pg_tables where schemaname = 'merlin'
          and tablename in ('profile_segment_' || _sd.dataset_id, 'span_' || _sd.dataset_id, 'event_' || _sd.dataset_id)) = 3,
    'partitions allocated';

  -- Profiles/spans with no resource_type / activity_type rows.
  insert into merlin.profile (dataset_id, name, type, duration)
  values (_sd.dataset_id, '/x', '{"type": "real", "schema": {"type": "real"}}', '1h');
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap)
  select _sd.dataset_id, id, '0h', null, true from merlin.profile where dataset_id = _sd.dataset_id;
  insert into merlin.span (dataset_id, span_id, parent_id, start_offset, duration, type, attributes)
  values (_sd.dataset_id, 1, null, '0h', '1h', 'OBSERVE', '{"arguments": {}, "computedAttributes": {}}');
  insert into merlin.span (dataset_id, span_id, parent_id, start_offset, duration, type, attributes)
  values (_other.dataset_id, 1, null, '0h', '1h', 'OBSERVE', '{"arguments": {}, "computedAttributes": {}}');

  assert (select count(*) from merlin.plan) = _plans_before, 'no plan created';
  assert (select count(*) from merlin.simulation_dataset) = _sims_before, 'no simulation dataset created';

  -- Cannot re-point the wrapper at another dataset.
  begin
    update merlin.standalone_dataset set dataset_id = _other.dataset_id where id = _sd.id;
    raise exception 'expected dataset_id update to fail';
  exception when raise_exception then
    assert sqlerrm like 'Cannot change the dataset%', sqlerrm;
  end;

  -- Wrapper delete -> dataset + partitions + rows gone; other wrapper untouched.
  delete from merlin.standalone_dataset where id = _sd.id;
  assert not exists(select from merlin.dataset where id = _sd.dataset_id), 'dataset deleted with wrapper';
  assert not exists(select from pg_tables where schemaname = 'merlin' and tablename = 'span_' || _sd.dataset_id), 'partitions dropped';
  assert not exists(select from merlin.profile where dataset_id = _sd.dataset_id), 'profiles deleted';
  assert exists(select from merlin.span where dataset_id = _other.dataset_id), 'other dataset untouched';

  -- Dataset delete -> wrapper gone, no double-delete error.
  delete from merlin.dataset where id = _other.dataset_id;
  get diagnostics _n = row_count;
  assert _n = 1, 'dataset deleted exactly once';
  assert not exists(select from merlin.standalone_dataset where id = _other.id), 'wrapper removed by FK cascade';

  raise notice 'standalone_dataset lifecycle checks passed';
end$$;

-- Any simulation_notification would be printed by psql here.
select 'no simulation notifications expected above' as check;

rollback;
