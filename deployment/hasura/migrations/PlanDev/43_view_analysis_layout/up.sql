create function ui.view_analysis_layout(v ui.view)
  returns boolean
  stable
  language sql
as $$
  select exists (
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

call migrations.mark_migration_applied(43);
