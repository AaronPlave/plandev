-- SPIKE 3 fixture: activity/span layers from two independent sources, with deliberate collisions.
-- Builds on spike2_multisource_fixture.sql (plan 'Spike 2 Plan', model 'Spike 2 Model').
--
--   psql "postgresql://plandev_admin:<password>@localhost:5432/plandev" -f deployment/spike/spike3_multisource_intervals_fixture.sql
--
-- Slot "plan": the plan's own directives + spans in its latest simulation dataset.
--   directive "Observe Europa"  OBSERVE @ 2029-001T01:00   -> span 1 (01:00-02:00), child span 2 SLEW (01:10-01:40)
--   directive "Observe Io"      OBSERVE @ 2029-003T04:30   -> span 3 (04:30-05:30), child span 4 SLEW (04:40-05:00)
--
-- Slot "tour": standalone datasets, never attached through plan_dataset.
--   'Imported Tour r1', 2029-003T00:00 -> 2029-006T00:00 (offsets are from the dataset's own start):
--     span 1 OBSERVE                   04:00-05:00 on 003   (same type AND same span_id as plan span 1;
--                                                            overlaps plan span 3 in time)
--     span 2 SLEW, parent 1            04:15-04:45 on 003   (same id/parent_id shape as plan span 2 -> 1)
--     span 3 INSTR_Decontamination    02:00-06:00 on 004
--     span 4 INSTR_SampleAcquisition  08:00-09:30 on 004
--     span 5 INSTR_SampleAcquisition  10:00-11:00 on 005
--     /battery/soc constant 40 %
--   'Imported Tour r2' (a later revision of the same product): everything 2h later, one extra
--     INSTR_Decontamination (span 6), /battery/soc constant 60 %.
--
-- Imported attributes follow the Merlin span shape ({arguments, computedAttributes}) because that is
-- what PlanDev's Parameter filter reads. Raw source organisation is kept under `provenance`.
do $$
declare
  _model int; _plan int; _sim_ds merlin.simulation_dataset; _d1 int; _d2 int; _sd merlin.standalone_dataset;
  _p int; _rev int; _shift interval;
begin
  select id into _model from merlin.mission_model where name = 'Spike 2 Model';
  select id into _plan from merlin.plan where name = 'Spike 2 Plan';

  -- Plan side ----------------------------------------------------------------------------------
  insert into merlin.activity_type (model_id, name, parameters, required_parameters, description) values
    (_model, 'OBSERVE', '{"target": {"order": 0, "schema": {"type": "string"}}}', '[]', 'Plan observation'),
    (_model, 'SLEW', '{"to": {"order": 0, "schema": {"type": "string"}}}', '[]', 'Plan slew')
  on conflict do nothing;

  insert into merlin.activity_directive (plan_id, name, type, start_offset, arguments)
    values (_plan, 'Observe Europa', 'OBSERVE', '1h', '{"target": "Europa"}') returning id into _d1;
  insert into merlin.activity_directive (plan_id, name, type, start_offset, arguments)
    values (_plan, 'Observe Io', 'OBSERVE', '52h30m', '{"target": "Io"}') returning id into _d2;

  select sd.* into _sim_ds from merlin.simulation_dataset sd join merlin.simulation s on s.id = sd.simulation_id
    where s.plan_id = _plan order by sd.id desc limit 1;

  insert into merlin.span (dataset_id, span_id, parent_id, start_offset, duration, type, attributes) values
    (_sim_ds.dataset_id, 1, null, '1h', '1h', 'OBSERVE',
      jsonb_build_object('arguments', '{"target": "Europa"}'::jsonb, 'computedAttributes', '{}'::jsonb, 'directiveId', _d1)),
    (_sim_ds.dataset_id, 2, 1, '1h10m', '30m', 'SLEW',
      '{"arguments": {"to": "Europa"}, "computedAttributes": {}}'),
    (_sim_ds.dataset_id, 3, null, '52h30m', '1h', 'OBSERVE',
      jsonb_build_object('arguments', '{"target": "Io"}'::jsonb, 'computedAttributes', '{}'::jsonb, 'directiveId', _d2)),
    (_sim_ds.dataset_id, 4, 3, '52h40m', '20m', 'SLEW',
      '{"arguments": {"to": "Io"}, "computedAttributes": {}}');

  -- Tour side: two revisions of one imported product -------------------------------------------
  for _rev in 1..2 loop
    _shift := make_interval(hours => (_rev - 1) * 2);
    insert into merlin.standalone_dataset (name, start_time, end_time)
      values ('Imported Tour r' || _rev, '2029-01-03T00:00:00Z', '2029-01-06T00:00:00Z')
      returning * into _sd;
    insert into merlin.span (dataset_id, span_id, parent_id, start_offset, duration, type, attributes) values
      (_sd.dataset_id, 1, null, '4h'::interval + _shift, '1h', 'OBSERVE',
        '{"arguments": {"legend": "Science", "subsystem": "INSTR"}, "computedAttributes": {},
          "provenance": {"sourcePath": "Activities by Legend/Science", "externalId": "TOUR-OBS-1"}}'),
      (_sd.dataset_id, 2, 1, '4h15m'::interval + _shift, '30m', 'SLEW',
        '{"arguments": {"legend": "Maneuvers", "subsystem": "GNC"}, "computedAttributes": {},
          "provenance": {"sourcePath": "Activities by Type/GNC/SLEW"}}'),
      (_sd.dataset_id, 3, null, '26h'::interval + _shift, '4h', 'INSTR_Decontamination',
        '{"arguments": {"legend": "INSTR", "subsystem": "INSTR"}, "computedAttributes": {},
          "provenance": {"sourcePath": "Activities by Type/INSTR/INSTR_Decontamination"}}'),
      (_sd.dataset_id, 4, null, '32h'::interval + _shift, '1h30m', 'INSTR_SampleAcquisition',
        '{"arguments": {"legend": "INSTR", "subsystem": "INSTR"}, "computedAttributes": {},
          "provenance": {"sourcePath": "Activities by Type/INSTR/INSTR_SampleAcquisition"}}'),
      (_sd.dataset_id, 5, null, '58h'::interval + _shift, '1h', 'INSTR_SampleAcquisition',
        '{"arguments": {"legend": "INSTR", "subsystem": "INSTR"}, "computedAttributes": {},
          "provenance": {"sourcePath": "Activities by Type/INSTR/INSTR_SampleAcquisition"}}');
    if _rev = 2 then
      insert into merlin.span (dataset_id, span_id, parent_id, start_offset, duration, type, attributes) values
        (_sd.dataset_id, 6, null, '64h', '2h', 'INSTR_Decontamination',
          '{"arguments": {"legend": "INSTR", "subsystem": "INSTR"}, "computedAttributes": {},
            "provenance": {"sourcePath": "Activities by Type/INSTR/INSTR_Decontamination"}}');
    end if;
    insert into merlin.profile (dataset_id, name, type, duration)
      values (_sd.dataset_id, '/battery/soc',
              '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "%"}}}}', '72h')
      returning id into _p;
    insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap)
      values (_sd.dataset_id, _p, '0h', jsonb_build_object('initial', 20 + 20 * _rev, 'rate', 0), false);
    raise notice 'Imported Tour r%: standalone_dataset.id=% dataset_id=%', _rev, _sd.id, _sd.dataset_id;
  end loop;

  raise notice 'plan_id=% sim dataset_id=% directives=%,%', _plan, _sim_ds.dataset_id, _d1, _d2;
end$$;
