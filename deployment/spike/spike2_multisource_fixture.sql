-- SPIKE 2 fixture: two independent sources that both expose /battery/soc.
--
--   psql "postgresql://plandev_admin:<password>@localhost:5432/plandev" -f deployment/spike/spike2_multisource_fixture.sql
--
-- Source A: an ordinary plan + a successful simulation_dataset (no merlin-server needed; rows are
--           written directly, the way a finished simulation leaves them).
--   plan        'Spike 2 Plan', 2029-01-01T00:00Z (2029-001), 10 days
--   model       'Spike 2 Model' declares /battery/soc (real, %) and /power/load (real, W)
--   sim profiles (offsets from simulation_start_time = plan start):
--     /battery/soc  70..90 %, sawtooth with 12h legs
--     /power/load   120..180 W
--
-- Source B: a standalone dataset (Spike 1 table), deliberately NOT attached through plan_dataset.
--   'Imported Power Product', 2029-01-03T00:00Z (2029-003) -> 2029-01-06T00:00Z (2029-006)
--   profiles (offsets from the standalone dataset's own start_time):
--     /battery/soc   30..50 %, with a step to exactly 45 at offset 24h = 2029-01-04T00:00Z
--     /thermal/temp  real, C
--
-- If Source B were (wrongly) offset from the plan start, its line would appear 2029-001 -> 2029-004.
do $$
declare
  _file int; _model int; _plan int; _sim_ds merlin.simulation_dataset; _p int; _sd merlin.standalone_dataset;
begin
  insert into merlin.uploaded_file (path, name) values ('spike2-path', 'spike2.jar') returning id into _file;
  insert into merlin.mission_model (name, mission, owner, version, jar_id)
    values ('Spike 2 Model', 'spike2', 'spike', '1', _file) returning id into _model;
  insert into merlin.resource_type (model_id, name, schema) values
    (_model, '/battery/soc', '{"type": "real", "metadata": {"unit": {"value": "%"}}}'),
    (_model, '/power/load', '{"type": "real", "metadata": {"unit": {"value": "W"}}}');
  insert into merlin.plan (name, model_id, duration, start_time, owner)
    values ('Spike 2 Plan', _model, '240h', '2029-01-01T00:00:00Z', 'spike') returning id into _plan;
  insert into merlin.simulation_dataset (simulation_id, arguments, simulation_start_time, simulation_end_time, status)
    select id, arguments, simulation_start_time, simulation_end_time, 'success' from merlin.simulation where plan_id = _plan
    returning * into _sim_ds;

  -- Source A /battery/soc: 90 -> 70 over 12h, 70 -> 90 over 12h, repeated for 10 days. 20% / 43200 s.
  insert into merlin.profile (dataset_id, name, type, duration)
    values (_sim_ds.dataset_id, '/battery/soc',
            '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "%"}}}}', '240h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap)
    select _sim_ds.dataset_id, _p, make_interval(hours => h),
           case when (h / 12) % 2 = 0 then '{"initial": 90, "rate": -0.000462963}'::jsonb
                else '{"initial": 70, "rate": 0.000462963}'::jsonb end,
           false
    from generate_series(0, 228, 12) as h;

  insert into merlin.profile (dataset_id, name, type, duration)
    values (_sim_ds.dataset_id, '/power/load',
            '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "W"}}}}', '240h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap)
    select _sim_ds.dataset_id, _p, make_interval(hours => h),
           jsonb_build_object('initial', case when (h / 6) % 2 = 0 then 120 else 180 end, 'rate', 0),
           false
    from generate_series(0, 234, 6) as h;

  -- Source B.
  insert into merlin.standalone_dataset (name, start_time, end_time)
    values ('Imported Power Product', '2029-01-03T00:00:00Z', '2029-01-06T00:00:00Z')
    returning * into _sd;
  insert into merlin.profile (dataset_id, name, type, duration)
    values (_sd.dataset_id, '/battery/soc',
            '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "%"}}}}', '72h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_sd.dataset_id, _p, '0h',  '{"initial": 30, "rate": 0.000231481}', false),  -- 30 -> 40 over 12h
    (_sd.dataset_id, _p, '12h', '{"initial": 40, "rate": -0.000115741}', false), -- 40 -> 35 over 12h
    (_sd.dataset_id, _p, '24h', '{"initial": 45, "rate": 0}', false),            -- step to 45 at 2029-01-04T00:00Z
    (_sd.dataset_id, _p, '36h', '{"initial": 50, "rate": -0.000115741}', false), -- 50 -> 45 over 12h
    (_sd.dataset_id, _p, '48h', '{"initial": 32, "rate": 0.000208333}', false);  -- 32 -> 50 over 24h
  insert into merlin.profile (dataset_id, name, type, duration)
    values (_sd.dataset_id, '/thermal/temp',
            '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "C"}}}}', '72h')
    returning id into _p;
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_sd.dataset_id, _p, '0h', '{"initial": 12, "rate": 0.0001}', false),
    (_sd.dataset_id, _p, '36h', '{"initial": 25, "rate": -0.0001}', false);

  raise notice 'plan_id=% simulation_dataset.id=% sim dataset_id=% standalone_dataset.id=% standalone dataset_id=%',
    _plan, _sim_ds.id, _sim_ds.dataset_id, _sd.id, _sd.dataset_id;
end$$;
