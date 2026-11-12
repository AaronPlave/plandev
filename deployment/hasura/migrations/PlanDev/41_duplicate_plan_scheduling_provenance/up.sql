-- TODO list:
--   - duplicate temporal subset of plan

create or replace function merlin.duplicate_plan(_plan_id integer, new_plan_name text, new_owner text)
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

/*
  Plans are merged following a three way merge (https://en.wikipedia.org/wiki/Merge_(version_control)#Three-way_merge)
  algorithm. After beginning a merge, the activities will be placed into one of two areas:
  a Merge Staging Area (MSA) and a Conflicting Activities table (CA).

  Where they will go is decided as follows:

  Difference btwn Source and MB | Difference btwn Target and MB | Outcome
  ------------------------------+-------------------------------+--------------------
            Add                 |             --                | Into MSA as Add
            --                  |             Add               | Into MSA as None
            None                |             None              | Into MSA as None
            Modify              |             None              | Into MSA as Modify
            Delete              |             None              | Into MSA as Delete
            None                |             Modify            | Into MSA as None
            Modify (Equal)      |             Modify (Equal)    | Into MSA as None
            Modify (Inequal)    |             Modify (Inequal)  | Into CA
            Delete              |             Modify            | Into CA
            None                |             Delete            | Dropped
            Modify              |             Delete            | Into CA
            Delete              |             Delete            | Dropped
 */
create or replace procedure merlin.begin_merge(_merge_request_id integer, review_username text)
  language plpgsql as $$
  declare
    validate_id integer;
    validate_status merlin.merge_request_status;
    validate_non_no_op_status merlin.activity_change_type;
    snapshot_id_supplying integer;
    plan_id_receiving integer;
    merge_base_id integer;
    start_time_receiving timestamptz;
    duration_receiving interval;
    start_time_supplying timestamptz;
    duration_supplying interval;
begin
  -- validate id and status
  select id, status
    from merlin.merge_request
    where _merge_request_id = id
    into validate_id, validate_status;

  if validate_id is null then
    raise exception 'Request ID % is not present in merge_request table.', _merge_request_id;
  end if;

  if validate_status != 'pending' then
    raise exception 'Cannot begin request. Merge request % is not in pending state.', _merge_request_id;
  end if;

  -- select from merge-request the snapshot_sc (s_sc) and plan_rc (p_rc) ids
  select plan_id_receiving_changes, snapshot_id_supplying_changes
    from merlin.merge_request
    where id = _merge_request_id
    into plan_id_receiving, snapshot_id_supplying;

  -- ensure that the plans cover the same boundaries
  select start_time, duration
  from merlin.plan
  where plan.id = plan_id_receiving
  into start_time_receiving, duration_receiving;

  select plan_start_time, plan_duration
  from merlin.plan_snapshot ps
  where ps.snapshot_id = snapshot_id_supplying
  into start_time_supplying, duration_supplying;

  if start_time_receiving is distinct from start_time_supplying or
     duration_receiving is distinct from duration_supplying then
    raise exception 'Cannot begin merge request between plans with different bounds.';
  end if;

  -- ensure the plan receiving changes isn't locked
  if (select is_locked from merlin.plan where plan.id=plan_id_receiving) then
    raise exception 'Cannot begin merge request. Plan to receive changes is locked.';
  end if;

  -- lock plan_rc
  update merlin.plan
    set is_locked = true
    where plan.id = plan_id_receiving;

  -- get merge base (mb)
  select merlin.get_merge_base(plan_id_receiving, snapshot_id_supplying)
    into merge_base_id;

  -- update the status to "in progress"
  update merlin.merge_request
    set status = 'in-progress',
    merge_base_snapshot_id = merge_base_id,
    reviewer_username = review_username
    where id = _merge_request_id;

  -- perform diff between mb and s_sc (s_diff)
    -- delete is B minus A on key
    -- add is A minus B on key
    -- A intersect B is no op
    -- A minus B on everything except everything currently in the table is modify
  create temp table supplying_diff(
    activity_id integer,
    change_type merlin.activity_change_type not null
  );

  insert into supplying_diff (activity_id, change_type)
  select activity_id, 'delete'
  from(
    select id as activity_id
    from merlin.plan_snapshot_activities
      where snapshot_id = merge_base_id
    except
    select id as activity_id
    from merlin.plan_snapshot_activities
      where snapshot_id = snapshot_id_supplying) a;

  insert into supplying_diff (activity_id, change_type)
  select activity_id, 'add'
  from(
    select id as activity_id
    from merlin.plan_snapshot_activities
      where snapshot_id = snapshot_id_supplying
    except
    select id as activity_id
    from merlin.plan_snapshot_activities
      where snapshot_id = merge_base_id) a;

  insert into supplying_diff (activity_id, change_type)
    select activity_id, 'none'
      from(
        select psa.id as activity_id, name, tags.tag_ids_activity_snapshot(psa.id, merge_base_id),
               source_scheduling_goal_id, created_at, start_offset, type, arguments,
               metadata, anchor_id, anchored_to_start
        from merlin.plan_snapshot_activities psa
        where psa.snapshot_id = merge_base_id
    intersect
      select id as activity_id, name, tags.tag_ids_activity_snapshot(psa.id, snapshot_id_supplying),
             source_scheduling_goal_id, created_at, start_offset, type, arguments,
             metadata, anchor_id, anchored_to_start
        from merlin.plan_snapshot_activities psa
        where psa.snapshot_id = snapshot_id_supplying) a;

  insert into supplying_diff (activity_id, change_type)
    select activity_id, 'modify'
    from(
      select id as activity_id from merlin.plan_snapshot_activities
        where snapshot_id = merge_base_id or snapshot_id = snapshot_id_supplying
      except
      select activity_id from supplying_diff) a;

  -- perform diff between mb and p_rc (r_diff)
  create temp table receiving_diff(
     activity_id integer,
     change_type merlin.activity_change_type not null
  );

  insert into receiving_diff (activity_id, change_type)
  select activity_id, 'delete'
  from(
        select id as activity_id
        from merlin.plan_snapshot_activities
        where snapshot_id = merge_base_id
        except
        select id as activity_id
        from merlin.activity_directive
        where plan_id = plan_id_receiving) a;

  insert into receiving_diff (activity_id, change_type)
  select activity_id, 'add'
  from(
        select id as activity_id
        from merlin.activity_directive
        where plan_id = plan_id_receiving
        except
        select id as activity_id
        from merlin.plan_snapshot_activities
        where snapshot_id = merge_base_id) a;

  insert into receiving_diff (activity_id, change_type)
  select activity_id, 'none'
  from(
        select id as activity_id, name, tags.tag_ids_activity_snapshot(id, merge_base_id),
               source_scheduling_goal_id, created_at, start_offset, type, arguments,
               metadata, anchor_id, anchored_to_start
        from merlin.plan_snapshot_activities psa
        where psa.snapshot_id = merge_base_id
        intersect
        select id as activity_id, name, tags.tag_ids_activity_directive(id, plan_id_receiving),
               source_scheduling_goal_id, created_at, start_offset, type, arguments,
               metadata, anchor_id, anchored_to_start
        from merlin.activity_directive ad
        where ad.plan_id = plan_id_receiving) a;

  insert into receiving_diff (activity_id, change_type)
  select activity_id, 'modify'
  from (
        (select id as activity_id
         from merlin.plan_snapshot_activities
         where snapshot_id = merge_base_id
         union
         select id as activity_id
         from merlin.activity_directive
         where plan_id = plan_id_receiving)
        except
        select activity_id
        from receiving_diff) a;


  -- perform diff between s_diff and r_diff
      -- upload the non-conflicts into merge_staging_area
      -- upload conflict into conflicting_activities
  create temp table diff_diff(
    activity_id integer,
    change_type_supplying merlin.activity_change_type not null,
    change_type_receiving merlin.activity_change_type not null
  );

  -- this is going to require us to do the "none" operation again on the remaining modifies
  -- but otherwise we can just dump the 'adds' and 'none' into the merge staging area table

  -- 'delete' against a 'delete' does not enter the merge staging area table
  -- receiving 'delete' against supplying 'none' does not enter the merge staging area table

  insert into merlin.merge_staging_area (
    merge_request_id, activity_id, name, tags, source_scheduling_goal_id, source_scheduling_goal_invocation_id,
    created_at, created_by, last_modified_by,
    start_offset, type, arguments, metadata, anchor_id, anchored_to_start, change_type
         )
  -- 'adds' can go directly into the merge staging area table
  select _merge_request_id, activity_id, name, tags.tag_ids_activity_snapshot(s_diff.activity_id, psa.snapshot_id),
         source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by, last_modified_by,
         start_offset, type, arguments, metadata, anchor_id, anchored_to_start, change_type
    from supplying_diff as  s_diff
    join merlin.plan_snapshot_activities psa
      on s_diff.activity_id = psa.id
    where snapshot_id = snapshot_id_supplying and change_type = 'add'
  union
  -- an 'add' between the receiving plan and merge base is actually a 'none'
  select _merge_request_id, activity_id, name, tags.tag_ids_activity_directive(r_diff.activity_id, ad.plan_id),
         source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by, last_modified_by,
         start_offset, type, arguments, metadata, anchor_id, anchored_to_start, 'none'::merlin.activity_change_type
    from receiving_diff as r_diff
    join merlin.activity_directive ad
      on r_diff.activity_id = ad.id
    where plan_id = plan_id_receiving and change_type = 'add';

  -- put the rest in diff_diff
  insert into diff_diff (activity_id, change_type_supplying, change_type_receiving)
  select activity_id, supplying_diff.change_type as change_type_supplying, receiving_diff.change_type as change_type_receiving
    from receiving_diff
    join supplying_diff using (activity_id)
  where receiving_diff.change_type != 'add' or supplying_diff.change_type != 'add';

  -- ...except for that which is not recorded
  delete from diff_diff
    where (change_type_receiving = 'delete' and  change_type_supplying = 'delete')
       or (change_type_receiving = 'delete' and change_type_supplying = 'none');

  insert into merlin.merge_staging_area (
    merge_request_id, activity_id, name, tags, source_scheduling_goal_id, source_scheduling_goal_invocation_id,
    created_at, created_by, last_modified_by,
    start_offset, type, arguments, metadata, anchor_id, anchored_to_start, change_type
  )
  -- receiving 'none' and 'modify' against 'none' in the supplying side go into the merge staging area as 'none'
  select _merge_request_id, activity_id, name, tags.tag_ids_activity_directive(diff_diff.activity_id, plan_id),
         source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by, last_modified_by,
         start_offset, type, arguments, metadata, anchor_id, anchored_to_start, 'none'
    from diff_diff
    join merlin.activity_directive
      on activity_id=id
    where plan_id = plan_id_receiving
      and change_type_supplying = 'none'
      and (change_type_receiving = 'modify' or change_type_receiving = 'none')
  union
  -- supplying 'modify' against receiving 'none' go into the merge staging area as 'modify'
  select _merge_request_id, activity_id, name, tags.tag_ids_activity_snapshot(diff_diff.activity_id, snapshot_id),  source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at,
         created_by, last_modified_by, start_offset, type, arguments, metadata, anchor_id, anchored_to_start, change_type_supplying
    from diff_diff
    join merlin.plan_snapshot_activities p
      on diff_diff.activity_id = p.id
    where snapshot_id = snapshot_id_supplying
      and (change_type_receiving = 'none' and diff_diff.change_type_supplying = 'modify')
  union
  -- supplying 'delete' against receiving 'none' go into the merge staging area as 'delete'
    select _merge_request_id, activity_id, name, tags.tag_ids_activity_directive(diff_diff.activity_id, plan_id),  source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at,
         created_by, last_modified_by, start_offset, type, arguments, metadata, anchor_id, anchored_to_start, change_type_supplying
    from diff_diff
    join merlin.activity_directive p
      on diff_diff.activity_id = p.id
    where plan_id = plan_id_receiving
      and (change_type_receiving = 'none' and diff_diff.change_type_supplying = 'delete');

  -- 'modify' against a 'modify' must be checked for equality first.
  with false_modify as (
    select activity_id, name, tags.tag_ids_activity_snapshot(dd.activity_id, psa.snapshot_id) as tags,
           source_scheduling_goal_id, created_at, start_offset, type, arguments, metadata, anchor_id, anchored_to_start
    from merlin.plan_snapshot_activities psa
    join diff_diff dd
      on dd.activity_id = psa.id
    where psa.snapshot_id = snapshot_id_supplying
      and (dd.change_type_receiving = 'modify' and dd.change_type_supplying = 'modify')
    intersect
    select activity_id, name, tags.tag_ids_activity_directive(dd.activity_id, ad.plan_id) as tags,
           source_scheduling_goal_id, created_at, start_offset, type, arguments, metadata, anchor_id, anchored_to_start
    from diff_diff dd
    join merlin.activity_directive ad
      on dd.activity_id = ad.id
    where ad.plan_id = plan_id_receiving
      and (dd.change_type_supplying = 'modify' and dd.change_type_receiving = 'modify'))
  insert into merlin.merge_staging_area (
    merge_request_id, activity_id, name, tags, source_scheduling_goal_id, source_scheduling_goal_invocation_id,
    created_at, created_by, last_modified_by,
    start_offset, type, arguments, metadata, anchor_id, anchored_to_start, change_type)
    select _merge_request_id, ad.id, ad.name, tags,  ad.source_scheduling_goal_id, ad.source_scheduling_goal_invocation_id,
           ad.created_at, ad.created_by, ad.last_modified_by, ad.start_offset, ad.type, ad.arguments, ad.metadata,
           ad.anchor_id, ad.anchored_to_start, 'none'
    from false_modify fm
    left join merlin.activity_directive ad
      on (ad.plan_id, ad.id) = (plan_id_receiving, fm.activity_id);

  -- 'modify' against 'delete' and inequal 'modify' against 'modify' goes into conflict table (aka everything left in diff_diff)
  insert into merlin.conflicting_activities (merge_request_id, activity_id, change_type_supplying, change_type_receiving)
  select begin_merge._merge_request_id, activity_id, change_type_supplying, change_type_receiving
  from (select begin_merge._merge_request_id, activity_id
        from diff_diff
        except
        select msa.merge_request_id, activity_id
        from merlin.merge_staging_area msa) a
  join diff_diff using (activity_id);

  -- Fail if there are no differences between the snapshot and the plan getting merged
  validate_non_no_op_status := null;
  select change_type_receiving
  from merlin.conflicting_activities
  where merge_request_id = _merge_request_id
  limit 1
  into validate_non_no_op_status;

  if validate_non_no_op_status is null then
    select change_type
    from merlin.merge_staging_area msa
    where merge_request_id = _merge_request_id
    and msa.change_type != 'none'
    limit 1
    into validate_non_no_op_status;

    if validate_non_no_op_status is null then
      raise exception 'Cannot begin merge. The contents of the two plans are identical.';
    end if;
  end if;


  -- clean up
  drop table supplying_diff;
  drop table receiving_diff;
  drop table diff_diff;
end
$$;

/*
  Commit merge takes all of the contents of the staging area and all of the resolved conflicts
  and applies the changes to the plan getting merged into.
 */
create or replace procedure merlin.commit_merge(_request_id integer)
  language plpgsql as $$
  declare
    validate_noConflicts integer;
    plan_id_R integer;
    snapshot_id_S integer;
begin
  if(select id from merlin.merge_request where id = _request_id) is null then
    raise exception 'Invalid merge request id %.', _request_id;
  end if;

  -- Stop if this merge is not 'in-progress'
  if (select status from merlin.merge_request where id = _request_id) != 'in-progress' then
    raise exception 'Cannot commit a merge request that is not in-progress.';
  end if;

  -- Stop if any conflicts have not been resolved
  select * from merlin.conflicting_activities
  where merge_request_id = _request_id and resolution = 'none'
  limit 1
  into validate_noConflicts;

  if(validate_noConflicts is not null) then
    raise exception 'There are unresolved conflicts in merge request %. Cannot commit merge.', _request_id;
  end if;

  select plan_id_receiving_changes from merlin.merge_request mr where mr.id = _request_id into plan_id_R;
  select snapshot_id_supplying_changes from merlin.merge_request mr where mr.id = _request_id into snapshot_id_S;

  insert into merlin.merge_staging_area(
    merge_request_id, activity_id, name, tags, source_scheduling_goal_id, source_scheduling_goal_invocation_id,
    created_at, created_by, last_modified_by,
    start_offset, type, arguments, metadata, anchor_id, anchored_to_start, change_type)
    -- gather delete data from the opposite tables
    select  _request_id, activity_id, name, tags.tag_ids_activity_directive(ca.activity_id, ad.plan_id),
            source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by, last_modified_by,
            start_offset, type, arguments, metadata, anchor_id, anchored_to_start,
            'delete'::merlin.activity_change_type
      from  merlin.conflicting_activities ca
      join  merlin.activity_directive ad
        on  ca.activity_id = ad.id
      where ca.resolution = 'supplying'
        and ca.merge_request_id = _request_id
        and plan_id = plan_id_R
        and ca.change_type_supplying = 'delete'
    union
    select  _request_id, activity_id, name, tags.tag_ids_activity_snapshot(ca.activity_id, psa.snapshot_id),
            source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at,
            created_by, last_modified_by, start_offset, type, arguments, metadata, anchor_id, anchored_to_start,
            'delete'::merlin.activity_change_type
      from  merlin.conflicting_activities ca
      join  merlin.plan_snapshot_activities psa
        on  ca.activity_id = psa.id
      where ca.resolution = 'receiving'
        and ca.merge_request_id = _request_id
        and snapshot_id = snapshot_id_S
        and ca.change_type_receiving = 'delete'
    union
    select  _request_id, activity_id, name, tags.tag_ids_activity_directive(ca.activity_id, ad.plan_id),
            source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by, last_modified_by,
            start_offset, type, arguments, metadata, anchor_id, anchored_to_start,
            'none'::merlin.activity_change_type
      from  merlin.conflicting_activities ca
      join  merlin.activity_directive ad
        on  ca.activity_id = ad.id
      where ca.resolution = 'receiving'
        and ca.merge_request_id = _request_id
        and plan_id = plan_id_R
        and ca.change_type_receiving = 'modify'
    union
    select  _request_id, activity_id, name, tags.tag_ids_activity_snapshot(ca.activity_id, psa.snapshot_id),
            source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by, last_modified_by,
            start_offset, type, arguments, metadata, anchor_id, anchored_to_start,
            'modify'::merlin.activity_change_type
      from  merlin.conflicting_activities ca
      join  merlin.plan_snapshot_activities psa
        on  ca.activity_id = psa.id
      where ca.resolution = 'supplying'
        and ca.merge_request_id = _request_id
        and snapshot_id = snapshot_id_S
        and ca.change_type_supplying = 'modify';

  -- Unlock so that updates can be written
  update merlin.plan
  set is_locked = false
  where id = plan_id_R;

  -- Update the plan's activities to match merge-staging-area's activities
  -- Add
  insert into merlin.activity_directive(
                id, plan_id, name, source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at,
                created_by, last_modified_by, start_offset, type, arguments, metadata, anchor_id, anchored_to_start )
  -- An added activity's goal invocation belongs to the supplying plan. Attribute it to the receiving plan's
  -- invocation of the same goal when there is exactly one; otherwise leave the invocation unset.
  select  activity_id, plan_id_R, name, source_scheduling_goal_id,
          (select min(rg.goal_invocation_id)
             from scheduler.scheduling_specification_goals rg
             join scheduler.scheduling_specification rs on rs.id = rg.specification_id
            where rs.plan_id = plan_id_R and rg.goal_id = msa.source_scheduling_goal_id
           having count(*) = 1),
          created_at, created_by, last_modified_by, start_offset, type, arguments, metadata, anchor_id, anchored_to_start
   from merlin.merge_staging_area msa
  where msa.merge_request_id = _request_id
    and change_type = 'add';

  -- Modify
  insert into merlin.activity_directive(
    id, plan_id, "name", source_scheduling_goal_id, source_scheduling_goal_invocation_id, created_at, created_by,
    last_modified_by, start_offset, "type", arguments, metadata, anchor_id, anchored_to_start )
  -- The mapped invocation is only used when the receiving plan no longer has the activity (a resolved
  -- delete/modify conflict); an existing activity keeps its own invocation (see the update below).
  select  activity_id, plan_id_R, "name", source_scheduling_goal_id,
          (select min(rg.goal_invocation_id)
             from scheduler.scheduling_specification_goals rg
             join scheduler.scheduling_specification rs on rs.id = rg.specification_id
            where rs.plan_id = plan_id_R and rg.goal_id = msa.source_scheduling_goal_id
           having count(*) = 1),
          created_at, created_by, last_modified_by,
          start_offset, "type", arguments, metadata, anchor_id, anchored_to_start
  from merlin.merge_staging_area msa
  where msa.merge_request_id = _request_id
    and change_type = 'modify'
  on conflict (id, plan_id)
  do update
  set name = excluded.name,
      source_scheduling_goal_id = excluded.source_scheduling_goal_id,
      -- source_scheduling_goal_invocation_id is per plan; keep the receiving plan's.
      created_at = excluded.created_at,
      created_by = excluded.created_by,
      last_modified_by = excluded.last_modified_by,
      start_offset = excluded.start_offset,
      type = excluded.type,
      arguments = excluded.arguments,
      metadata = excluded.metadata,
      anchor_id = excluded.anchor_id,
      anchored_to_start = excluded.anchored_to_start;

  -- Tags
  delete from tags.activity_directive_tags adt
    using merlin.merge_staging_area msa
    where adt.directive_id = msa.activity_id
      and adt.plan_id = plan_id_R
      and msa.merge_request_id = _request_id
      and msa.change_type = 'modify';

  insert into tags.activity_directive_tags(plan_id, directive_id, tag_id)
    select plan_id_R, activity_id, t.id
    from merlin.merge_staging_area msa
    inner join tags.tags t -- Inner join because it's specifically inserting into a tags-association table, so if there are no valid tags we do not want a null value for t.id
    on t.id = any(msa.tags)
    where msa.merge_request_id = _request_id
      and (change_type = 'modify'
       or change_type = 'add')
    on conflict (directive_id, plan_id, tag_id) do nothing;
  -- Presets
  insert into merlin.preset_to_directive(preset_id, activity_id, plan_id)
  select pts.preset_id, pts.activity_id, plan_id_R
  from merlin.merge_staging_area msa
  inner join merlin.preset_to_snapshot_directive pts using (activity_id)
  where pts.snapshot_id = snapshot_id_S
    and msa.merge_request_id = _request_id
    and (msa.change_type = 'add'
     or msa.change_type = 'modify')
  on conflict (activity_id, plan_id)
    do update
    set preset_id = excluded.preset_id;

  -- Delete
  delete from merlin.activity_directive ad
  using merlin.merge_staging_area msa
  where ad.id = msa.activity_id
    and ad.plan_id = plan_id_R
    and msa.merge_request_id = _request_id
    and msa.change_type = 'delete';

  -- Clean up
  delete from merlin.conflicting_activities where merge_request_id = _request_id;
  delete from merlin.merge_staging_area where merge_staging_area.merge_request_id = _request_id;

  update merlin.merge_request
  set status = 'accepted'
  where id = _request_id;

  -- Attach snapshot history
  insert into merlin.plan_latest_snapshot(plan_id, snapshot_id)
  select plan_id_receiving_changes, snapshot_id_supplying_changes
  from merlin.merge_request
  where id = _request_id;
end
$$;

call migrations.mark_migration_applied('41');
