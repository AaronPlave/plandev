create function merlin.source_activity_step(a merlin.source_activity)
  returns numeric
  immutable
  language sql
as $$
  select case when jsonb_typeof(a.metadata -> 'step') = 'number' then (a.metadata ->> 'step')::numeric end;
$$;

comment on function merlin.source_activity_step(merlin.source_activity) is e''
  'The record''s place among its parent''s steps, as its product gives it (metadata.step), or null when it gives none. '
  'Lets a sequence''s steps be read, and limited, in the product''s order rather than by time.';
