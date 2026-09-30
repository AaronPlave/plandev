-- Local fixture for the Plan Catalog / Sources work. Uses only existing entities.
-- Expects a plan named 'Spike 2 Plan' (2029-001, 10 days) whose latest simulation produced /battery/soc.
--
--   psql "postgresql://<user>:<password>@localhost:5432/plandev" -f docs/sources/sources_fixture.sql
--
-- External datasets (plan_dataset rows; each is its own source):
--   A  plan-level                         /battery/soc  ramps 90 -> 30 %, /thermal/panel,
--                                         /power 120 W, /mode real (1)
--   B  tied to the plan's latest sim      /battery/soc  constant 55 %, /power 0.2 kW, /mode variant (SAFE)
--   (same name + same schema, same name + different unit, same name + different schema family)
-- External events (derivation groups linked to the plan):
--   "DSN Passes"   (source type DSN)       two sources, event types Pass / Handover
--   "Backup Passes" (source type DSN)      one source,  event type Pass (same type in another group)
--   "Eclipses"     (source type Ephemeris) one source,  event type Eclipse
do $$
declare
  _plan int; _sim_ds int; _ds int; _p int;
begin
  select id into _plan from merlin.plan where name = 'Spike 2 Plan';
  select sd.id into _sim_ds from merlin.simulation_dataset sd join merlin.simulation s on s.id = sd.simulation_id
    where s.plan_id = _plan order by sd.id desc limit 1;

  -- Dataset A: plan-level
  insert into merlin.plan_dataset (plan_id, dataset_id, simulation_dataset_id, offset_from_plan_start)
    values (_plan, null, null, '0h') returning dataset_id into _ds;
  insert into merlin.profile (dataset_id, name, type, duration) values
    (_ds, '/battery/soc', '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "%"}}}}', '240h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_ds, _p, '0h', '{"initial": 90, "rate": -0.00006944}', false);
  insert into merlin.profile (dataset_id, name, type, duration) values
    (_ds, '/thermal/panel', '{"type": "real", "schema": {"type": "real"}}', '240h') returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_ds, _p, '0h', '{"initial": 20, "rate": 0}', false);
  insert into merlin.profile (dataset_id, name, type, duration) values
    (_ds, '/power', '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "W"}}}}', '240h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_ds, _p, '0h', '{"initial": 120, "rate": 0}', false);
  insert into merlin.profile (dataset_id, name, type, duration) values
    (_ds, '/mode', '{"type": "real", "schema": {"type": "real"}}', '240h') returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_ds, _p, '0h', '{"initial": 1, "rate": 0}', false);
  raise notice 'Dataset A: dataset_id=% (plan-level)', _ds;

  -- Dataset B: tied to the latest simulation
  insert into merlin.plan_dataset (plan_id, dataset_id, simulation_dataset_id, offset_from_plan_start)
    values (_plan, null, _sim_ds, '0h') returning dataset_id into _ds;
  insert into merlin.profile (dataset_id, name, type, duration) values
    (_ds, '/battery/soc', '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "%"}}}}', '240h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_ds, _p, '0h', '{"initial": 55, "rate": 0}', false);
  insert into merlin.profile (dataset_id, name, type, duration) values
    (_ds, '/power', '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "kW"}}}}', '240h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_ds, _p, '0h', '{"initial": 0.2, "rate": 0}', false);
  insert into merlin.profile (dataset_id, name, type, duration) values
    (_ds, '/mode', '{"type": "discrete", "schema": {"type": "variant", "variants": [{"key": "SAFE", "label": "SAFE"}, {"key": "SCIENCE", "label": "SCIENCE"}]}}', '240h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_ds, _p, '0h', '"SAFE"', false), (_ds, _p, '96h', '"SCIENCE"', false);
  raise notice 'Dataset B: dataset_id=% (simulation_dataset %)', _ds, _sim_ds;

  -- External events
  insert into merlin.external_source_type (name) values ('DSN'), ('Ephemeris') on conflict do nothing;
  insert into merlin.external_event_type (name) values ('Pass'), ('Handover'), ('Eclipse') on conflict do nothing;
  insert into merlin.derivation_group (name, source_type_name) values
    ('DSN Passes', 'DSN'), ('Backup Passes', 'DSN'), ('Eclipses', 'Ephemeris');
  insert into merlin.external_source (key, source_type_name, derivation_group_name, valid_at, start_time, end_time) values
    ('dsn_week1.json', 'DSN', 'DSN Passes', '2028-12-30Z', '2029-01-01Z', '2029-01-06Z'),
    ('dsn_week2.json', 'DSN', 'DSN Passes', '2028-12-31Z', '2029-01-06Z', '2029-01-11Z'),
    ('backup.json', 'DSN', 'Backup Passes', '2028-12-30Z', '2029-01-01Z', '2029-01-11Z'),
    ('eclipses.json', 'Ephemeris', 'Eclipses', '2028-12-30Z', '2029-01-01Z', '2029-01-11Z');
  insert into merlin.external_event (key, event_type_name, source_key, derivation_group_name, start_time, duration) values
    ('pass-1', 'Pass', 'dsn_week1.json', 'DSN Passes', '2029-01-01T06:00Z', '4h'),
    ('pass-2', 'Pass', 'dsn_week1.json', 'DSN Passes', '2029-01-03T06:00Z', '4h'),
    ('handover-1', 'Handover', 'dsn_week1.json', 'DSN Passes', '2029-01-03T10:00Z', '30m'),
    ('pass-3', 'Pass', 'dsn_week2.json', 'DSN Passes', '2029-01-07T06:00Z', '4h'),
    ('backup-pass-1', 'Pass', 'backup.json', 'Backup Passes', '2029-01-04T18:00Z', '3h'),
    ('eclipse-1', 'Eclipse', 'eclipses.json', 'Eclipses', '2029-01-02T12:00Z', '90m'),
    ('eclipse-2', 'Eclipse', 'eclipses.json', 'Eclipses', '2029-01-05T12:00Z', '90m');
  insert into merlin.plan_derivation_group (plan_id, derivation_group_name) values
    (_plan, 'DSN Passes'), (_plan, 'Backup Passes'), (_plan, 'Eclipses');
end$$;
