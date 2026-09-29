-- SPIKE fixture: one standalone dataset with no plan, mission model, or simulation.
--
--   psql "postgresql://plandev_admin:<password>@localhost:5432/plandev" -f deployment/spike/standalone_dataset_fixture.sql
--
-- Contents (all offsets relative to standalone_dataset.start_time = 2029-01-01T00:00:00Z, 2 days long):
--   /power/load   real      unit W   includes a profile gap (is_gap = true)          10h -> 12h
--   /battery/soc  real      unit %
--   /battery/mode discrete  variant  includes a valid null value (is_gap = false)   20h -> 24h
--                                    and a profile gap (is_gap = true)                30h -> 34h
-- Gaps use Merlin's encoding (dynamics = JSON null, is_gap = true). A valid discrete null has the same
-- dynamics with is_gap = false, so is_gap is the only thing distinguishing the two.
--   spans: OBSERVE, DOWNLINK, SLEW (one SLEW is a child of an OBSERVE), with no activity_type rows.
do $$
declare
  _dataset_id integer;
  _load_id integer;
  _soc_id integer;
  _mode_id integer;
begin
  insert into merlin.standalone_dataset (name, start_time, end_time)
  values ('Spike: power.csv', '2029-01-01T00:00:00Z', '2029-01-03T00:00:00Z')
  returning dataset_id into _dataset_id;

  -- Profiles carry their own type + ValueSchema; no resource_type rows are involved.
  insert into merlin.profile (dataset_id, name, type, duration)
  values (_dataset_id, '/power/load',
          '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "W"}}}}', '48h')
  returning id into _load_id;

  insert into merlin.profile (dataset_id, name, type, duration)
  values (_dataset_id, '/battery/soc',
          '{"type": "real", "schema": {"type": "real", "metadata": {"unit": {"value": "%"}}}}', '48h')
  returning id into _soc_id;

  insert into merlin.profile (dataset_id, name, type, duration)
  values (_dataset_id, '/battery/mode',
          '{"type": "discrete", "schema": {"type": "variant", "variants": [
             {"key": "CHARGING", "label": "CHARGING"},
             {"key": "DISCHARGING", "label": "DISCHARGING"},
             {"key": "IDLE", "label": "IDLE"}]}}', '48h')
  returning id into _mode_id;

  -- Real profile segments: dynamics = {initial, rate (per second)}.
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_dataset_id, _load_id, '0h',  '{"initial": 200, "rate": 0}', false),
    (_dataset_id, _load_id, '2h',  '{"initial": 200, "rate": 0.015}', false),
    (_dataset_id, _load_id, '6h',  '{"initial": 416, "rate": 0}', false),
    -- Profile gap, encoded exactly as Merlin writes one (PostProfileSegmentsAction): JSON null + is_gap.
    (_dataset_id, _load_id, '10h', 'null'::jsonb, true),
    (_dataset_id, _load_id, '12h', '{"initial": 350, "rate": -0.002}', false),
    (_dataset_id, _load_id, '24h', '{"initial": 263.6, "rate": 0}', false),
    (_dataset_id, _load_id, '36h', '{"initial": 300, "rate": 0.001}', false);

  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_dataset_id, _soc_id, '0h',  '{"initial": 80, "rate": -0.0002}', false),
    (_dataset_id, _soc_id, '12h', '{"initial": 71.36, "rate": 0.0003}', false),
    (_dataset_id, _soc_id, '24h', '{"initial": 84.32, "rate": -0.0001}', false);

  -- Discrete profile segments: dynamics = the value itself.
  insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap) values
    (_dataset_id, _mode_id, '0h',  '"DISCHARGING"', false),
    (_dataset_id, _mode_id, '12h', '"CHARGING"', false),
    -- Valid discrete null: the value is known to be null.
    (_dataset_id, _mode_id, '20h', 'null'::jsonb, false),
    (_dataset_id, _mode_id, '24h', '"IDLE"', false),
    -- Profile gap: value unknown. Same dynamics as the valid null above; only is_gap differs.
    (_dataset_id, _mode_id, '30h', 'null'::jsonb, true),
    (_dataset_id, _mode_id, '34h', '"DISCHARGING"', false);

  -- Spans: only span.type, timing, hierarchy, and attributes. No activity_type rows exist for these.
  insert into merlin.span (dataset_id, span_id, parent_id, start_offset, duration, type, attributes) values
    (_dataset_id, 1, null, '1h',  '3h',   'OBSERVE',  '{"arguments": {"target": "M31", "instrument": "CAM"}, "computedAttributes": {}}'),
    (_dataset_id, 2, 1,    '1h',  '20m',  'SLEW',     '{"arguments": {"from": "EARTH", "to": "M31"}, "computedAttributes": {"slewAngle": 42.5}}'),
    (_dataset_id, 3, null, '5h',  '1h',   'DOWNLINK', '{"arguments": {"station": "DSS-14", "rate": 2000}, "computedAttributes": {}}'),
    (_dataset_id, 4, null, '13h', '30m',  'SLEW',     '{"arguments": {"from": "M31", "to": "M42"}, "computedAttributes": {"slewAngle": 12.0}}'),
    (_dataset_id, 5, null, '14h', '4h',   'OBSERVE',  '{"arguments": {"target": "M42", "instrument": "SPEC"}, "computedAttributes": {}}'),
    (_dataset_id, 6, null, '26h', '90m',  'DOWNLINK', '{"arguments": {"station": "DSS-43", "rate": 4000}, "computedAttributes": {}}');

  raise notice 'Created standalone dataset (dataset_id=%)', _dataset_id;
end$$;

select id, name, dataset_id, start_time, end_time from merlin.standalone_dataset order by id desc limit 1;
