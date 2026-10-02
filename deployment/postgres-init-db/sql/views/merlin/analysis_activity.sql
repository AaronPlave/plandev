create view merlin.analysis_activity as
(
  select 'revision'::text as source_kind,
         a.revision_id as source_ref,
         a.id as activity_id,
         a.type,
         a.name,
         a.category,
         a.start_time,
         a.end_time
    from merlin.source_activity a
  union all
  select 'simulation'::text,
         sd.id,
         span.span_id,
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
);

comment on view merlin.analysis_activity is e''
  'Activities from the kinds of source an analysis can compose, in one shape for browsing: an imported '
  'revision''s activities (source_kind revision, source_ref the revision id) and a simulation dataset''s spans '
  '(source_kind simulation, source_ref the simulation dataset id). (source_kind, source_ref, activity_id) '
  'identifies an activity; details stay in source_activity and span.';
comment on column merlin.analysis_activity.name is e''
  'An imported activity''s own name; for a span, the current name of the directive it came from, else its type.';
