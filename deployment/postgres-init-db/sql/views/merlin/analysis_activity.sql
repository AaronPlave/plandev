create function merlin.analysis_external_event_id(
  _derivation_group_name text,
  _source_key text,
  _event_type_name text,
  _event_key text
) returns bigint
  language plpgsql
  immutable
  parallel safe
as $$
declare
  part text;
  hash bigint := 2166136261; -- FNV-1a offset basis
  i int;
  first boolean := true;
begin
  foreach part in array array[_derivation_group_name, _source_key, _event_type_name, _event_key] loop
    if not first then
      -- The UI joins the parts with U+0000: xor with 0 leaves the hash, then the multiply.
      hash := (hash * 16777619) % 4294967296;
    end if;
    first := false;
    for i in 1..length(part) loop
      hash := ((hash # ascii(substr(part, i, 1))) * 16777619) % 4294967296;
    end loop;
  end loop;
  return 2147483648 + (hash & 2147483647);
end
$$;

comment on function merlin.analysis_external_event_id(text, text, text, text) is e''
  'The activity id an analysis gives a plan''s external event (it has no integer id of its own): 2^31 plus a 31-bit '
  'FNV-1a hash of its identity (derivation group, source key, type, key), the same as the UI''s getExternalEventId, so '
  'it never collides with a directive id and is stable across reads. Hashed by Unicode code point, as the UI does.';

create view merlin.analysis_activity as
(
  select 'revision'::text as source_kind,
         a.revision_id as source_ref,
         a.id::bigint as activity_id,
         a.type,
         a.name,
         a.category,
         a.start_time,
         a.end_time
    from merlin.source_activity a
  union all
  select 'simulation'::text,
         sd.id,
         span.span_id::bigint,
         span.type,
         coalesce(directive.name, span.type),
         null::text,
         sd.simulation_start_time + span.start_offset,
         sd.simulation_start_time + span.start_offset + coalesce(span.duration, interval '0')
    from merlin.simulation_dataset sd
    join merlin.span span on span.dataset_id = sd.dataset_id
    join merlin.simulation sim on sim.id = sd.simulation_id
    left join merlin.activity_directive directive
      on directive.plan_id = sim.plan_id and directive.id = (span.attributes#>>'{directiveId}')::integer
  union all
  -- A plan's current directives. Their start is the anchor-resolved approximate start; a directive has no end.
  -- ponytail: get_approximate_start_time walks anchors per row; fine for plans of a few thousand directives,
  -- a materialized start per directive if sorting large plans gets slow.
  select 'plan'::text,
         ad.plan_id,
         ad.id::bigint,
         ad.type,
         coalesce(nullif(ad.name, ''), ad.type),
         null::text,
         merlin.get_approximate_start_time(ad.id, ad.plan_id),
         null::timestamptz
    from merlin.activity_directive ad
  union all
  -- The external events of the derivation groups linked to a plan, as derived: records of the plan's source in an
  -- analysis, as on its timeline. Category is the derivation group.
  select 'plan'::text,
         pdg.plan_id,
         merlin.analysis_external_event_id(de.derivation_group_name, de.source_key, de.event_type_name, de.event_key),
         de.event_type_name,
         de.event_key,
         de.derivation_group_name,
         de.start_time,
         de.start_time + de.duration
    from merlin.plan_derivation_group pdg
    join merlin.derived_events de on de.derivation_group_name = pdg.derivation_group_name
);

comment on view merlin.analysis_activity is e''
  'Activities from the kinds of source an analysis can compose, in one shape for browsing: an imported '
  'revision''s activities (source_kind revision, source_ref the revision id), a simulation dataset''s spans '
  '(source_kind simulation, source_ref the simulation dataset id), and a plan''s current directives (source_kind '
  'plan, source_ref the plan id; no end_time) and the external events of its linked derivation groups (source_kind '
  'plan, activity_id from analysis_external_event_id, category the derivation group). (source_kind, source_ref, '
  'activity_id) identifies an activity; details stay in source_activity, span and derived_events.';
comment on column merlin.analysis_activity.name is e''
  'An imported activity''s own name; for a span, the current name of the directive it came from, else its type; for '
  'an external event, its key.';
