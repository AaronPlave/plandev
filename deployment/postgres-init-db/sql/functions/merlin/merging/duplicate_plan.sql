-- TODO list:
--   - duplicate temporal subset of plan

create function merlin.duplicate_plan(_plan_id integer, new_plan_name text, new_owner text)
  returns integer -- plan_id of the new plan
  security definer
  language plpgsql as $$
  declare
    new_plan_id integer;
    created_snapshot_id integer;
    source_spec_id integer;
    new_spec_id integer;
begin
  if not exists(select from merlin.plan where plan.id = _plan_id) then
    raise exception 'Plan % does not exist.', _plan_id;
  end if;

  -- Check that the plan is not readonly
  if (select is_read_only from merlin.plan where plan.id = _plan_id) then
    raise exception 'Cannot branch a read only plan.';
  end if;

  select merlin.create_snapshot(_plan_id) into created_snapshot_id;

  insert into merlin.plan(revision, name, model_id, duration, start_time, parent_id, owner, updated_by)
    select
        0, new_plan_name, model_id, duration, start_time, _plan_id, new_owner, new_owner
    from merlin.plan where id = _plan_id
    returning id into new_plan_id;
  -- The plan insert triggers populated the new plan's scheduling and constraint specifications
  -- from the model's defaults. Replace them with copies of the source plan's specifications.
  select id from scheduler.scheduling_specification where plan_id = _plan_id into source_spec_id;
  select id from scheduler.scheduling_specification where plan_id = new_plan_id into new_spec_id;

  update scheduler.scheduling_specification new_spec
  set horizon_start = source_spec.horizon_start,
      horizon_end = source_spec.horizon_end,
      simulation_arguments = source_spec.simulation_arguments,
      analysis_only = source_spec.analysis_only
  from scheduler.scheduling_specification source_spec
  where source_spec.id = source_spec_id and new_spec.id = new_spec_id;

  delete from scheduler.scheduling_specification_goals where specification_id = new_spec_id;
  -- Inserted in priority order so each row takes the next free priority, preserving the source order.
  insert into scheduler.scheduling_specification_goals(
      specification_id, goal_id, goal_revision, priority, enabled, arguments, simulate_after)
    select new_spec_id, goal_id, goal_revision, priority, enabled, arguments, simulate_after
    from scheduler.scheduling_specification_goals
    where specification_id = source_spec_id
    order by priority;

  delete from scheduler.scheduling_specification_conditions where specification_id = new_spec_id;
  insert into scheduler.scheduling_specification_conditions(specification_id, condition_id, condition_revision, enabled)
    select new_spec_id, condition_id, condition_revision, enabled
    from scheduler.scheduling_specification_conditions
    where specification_id = source_spec_id;

  delete from merlin.constraint_specification where plan_id = new_plan_id;
  insert into merlin.constraint_specification(plan_id, constraint_id, constraint_revision, enabled, arguments, priority)
    select new_plan_id, constraint_id, constraint_revision, enabled, arguments, priority
    from merlin.constraint_specification
    where plan_id = _plan_id
    order by priority;

  -- Goal invocations are per plan. A copied directive points at the new plan's copy of the invocation
  -- that created it (matched by priority, which is unique within a specification). A directive whose
  -- invocation is not in the source specification keeps its source goal but loses the invocation.
  insert into merlin.activity_directive(
      id, plan_id, name, source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by,
      last_modified_at, last_modified_by, start_offset, type, arguments,
      last_modified_arguments_at, metadata, anchor_id, anchored_to_start)
    select
      ad.id, new_plan_id, ad.name, ad.source_scheduling_goal_id, new_goal.goal_invocation_id, ad.created_at, ad.created_by,
      ad.last_modified_at, ad.last_modified_by, ad.start_offset, ad.type, ad.arguments,
      ad.last_modified_arguments_at, ad.metadata, ad.anchor_id, ad.anchored_to_start
    from merlin.activity_directive ad
    left join scheduler.scheduling_specification_goals source_goal
      on source_goal.goal_invocation_id = ad.source_scheduling_goal_invocation_id
     and source_goal.specification_id = source_spec_id
    left join scheduler.scheduling_specification_goals new_goal
      on new_goal.specification_id = new_spec_id
     and new_goal.priority = source_goal.priority
    where ad.plan_id = _plan_id;

  with source_plan as (
    select simulation_template_id, arguments, simulation_start_time, simulation_end_time
    from merlin.simulation
    where simulation.plan_id = _plan_id
  )
  update merlin.simulation s
  set simulation_template_id = source_plan.simulation_template_id,
      arguments = source_plan.arguments,
      simulation_start_time = source_plan.simulation_start_time,
      simulation_end_time = source_plan.simulation_end_time
  from source_plan
  where s.plan_id = new_plan_id;

  insert into merlin.preset_to_directive(preset_id, activity_id, plan_id)
    select preset_id, activity_id, new_plan_id
    from merlin.preset_to_directive ptd where ptd.plan_id = _plan_id;

  insert into tags.plan_tags(plan_id, tag_id)
    select new_plan_id, tag_id
    from tags.plan_tags pt where pt.plan_id = _plan_id;
  insert into tags.activity_directive_tags(plan_id, directive_id, tag_id)
    select new_plan_id, directive_id, tag_id
    from tags.activity_directive_tags adt where adt.plan_id = _plan_id;

  insert into merlin.plan_latest_snapshot(plan_id, snapshot_id) values(new_plan_id, created_snapshot_id);
  return new_plan_id;
end
$$;

comment on function merlin.duplicate_plan(plan_id integer, new_plan_name text, new_owner text) is e''
  'Copies all of a given plan''s properties and activities into a new plan with the specified name.
  The new plan gets copies of the source plan''s scheduling specification (goal invocations, conditions and
  settings) and constraint specification. Copied activities that were created by a scheduling goal point at
  the new plan''s copy of that goal invocation.
  When duplicating a plan, a snapshot is created of the original plan.
  Additionally, that snapshot becomes the latest snapshot of the new plan.';
