create function ui.view_analysis_layout(v ui.view)
  returns boolean
  stable
  language sql
as $$
  -- Said by the layout itself (definition.analysisLayout, which also describes its sources), so one with no data
  -- layers yet, or only guides, is still a layout. Views saved before that are recognized by their layers.
  select v.definition ? 'analysisLayout' or exists (
    select 1
      from jsonb_array_elements(coalesce(v.definition -> 'plan' -> 'timelines', '[]')) t,
           jsonb_array_elements(coalesce(t -> 'rows', '[]')) r,
           jsonb_array_elements(coalesce(r -> 'layers', '[]')) l
     where l ->> 'sourceId' ~ '^(plan|revision|simulation):[0-9]+$'
  );
$$;

comment on function ui.view_analysis_layout(ui.view) is e''
  'Whether the view is a layout saved from an Analysis: its layers name the data they read (revision:<id>, '
  'simulation:<id>, plan:<id>) rather than a plan''s own sources, so it is used from an Analysis, not opened on a Plan.';
