-- Sprint 149 (WS-6 leftover; APEX 26.2: in-flight workflow migration): running instances inside parallel branches
-- move to a newer version too. Migration 123 refused them ("let them reach their join first").
--
-- An instance inside branches is at several steps at once: its main path waits at a join (or, nested, a branch
-- waits at an inner join), and each open branch (active, waiting or faulted) is at a step of its own. Each of these
-- positions is mapped like the main path was (p_map: old step → new step) and checked with the same rules (a task
-- step stays a task step of the same task definition, a wait stays a wait, a join stays a join, no draft step, no
-- call in flight). Branch rows also keep the parallel step that split them and the join they end at: the join is
-- renamed through the mapping (it must be a join step of the new version; a branch can't be mapped onto its own
-- join), the split through the mapping or else to the one parallel step of the new version that joins there. Branches that are already done keep their state, so a join counts them as before.
--
-- meta.migrate_workflows returns one row per position (the column branch: the branch's first step, null for the
-- main path); applying moves every position of every instance in one transaction, or nothing.

drop function meta.migrate_workflows(int, text, bigint[], jsonb, boolean, text);

/** The problem that stops one position (a main path or a branch) from moving to p_to; null: it can move. */
create function meta.workflow_position_problem(p_state text, p_from_steps jsonb, p_from text, p_to_steps jsonb, p_to text,
                                               p_waiting_task bigint, p_task_name text, p_to_version text)
returns text language plpgsql stable set search_path = meta, pg_catalog as $$
declare
  v_to   jsonb := (select s from jsonb_array_elements(p_to_steps) s where s->>'name' = p_to limit 1);
  v_from jsonb := (select s from jsonb_array_elements(p_from_steps) s where s->>'name' = p_from limit 1);
begin
  if p_to is null or p_to = '' then
    return format('no step of version %s is mapped to %s', p_to_version, coalesce(p_from, '(none)'));
  elsif v_to is null then
    return format('version %s has no step %s', p_to_version, p_to);
  elsif v_to->>'type' = 'draft' then
    return format('%s is a draft step', p_to);
  elsif p_waiting_task is not null and v_to->>'type' <> 'task' then
    return format('waits for a task: %s must be a task step', p_to);
  elsif p_waiting_task is not null and upper(v_to->>'task') is distinct from p_task_name then
    return format('waits for a task of %s, but %s creates %s', p_task_name, p_to, coalesce(v_to->>'task', '(none)'));
  elsif p_state = 'waiting' and p_waiting_task is null and v_from->>'type' = 'invoke_api' then
    return 'is calling a web service: try again when the call is done';
  elsif p_state = 'waiting' and p_waiting_task is null and v_from->>'type' = 'wait' and v_to->>'type' <> 'wait' then
    return format('waits at a wait step: %s must be a wait step', p_to);
  elsif p_state = 'waiting' and p_waiting_task is null and v_from->>'type' = 'join' and v_to->>'type' <> 'join' then
    return format('waits at a join: %s must be a join step', p_to);
  end if;
  return null;
end
$$;
revoke all on function meta.workflow_position_problem(text, jsonb, text, jsonb, text, bigint, text, text) from public;

/**
 * Move running instances (p_ids) of a definition to a newer version (p_to_version: the active version or a later
 * inactive one), each position at the step p_map gives for its current step. Returns one row per position (branch:
 * the branch's first step, null for the main path) with the problem that stops it (null: it can move). With p_apply,
 * nothing changes unless every position of every instance can move; then all move in this transaction, with a
 * "migrated" event each and a row in meta.workflow_migration.
 */
create function meta.migrate_workflows(p_definition_id int, p_to_version text, p_ids bigint[], p_map jsonb, p_apply boolean, p_by text)
returns table (workflow_id bigint, branch text, from_version text, from_step text, to_step text, problem text)
language plpgsql set search_path = meta, pg_catalog as $$
declare
  d        meta.workflow_definition;
  v_order  text[];
  v_target int;
  v_steps  jsonb;
  w        record;
  b        record;
  v_rows   jsonb := '[]';
  v_bad    text[] := '{}';
  v_id     bigint;
  v_join   text;
  v_split  text;
  r        jsonb;
begin
  select * into d from workflow_definition where id = p_definition_id;
  if not found then
    raise exception 'Workflow definition % does not exist.', p_definition_id;
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 then
    raise exception 'Choose the instances to migrate.';
  end if;
  if jsonb_typeof(coalesce(p_map, '{}')) <> 'object' then
    raise exception 'The step mapping is a JSON object.';
  end if;
  -- versions from the oldest to the active one
  v_order := array(select x->>'version' from jsonb_array_elements(d.inactive_versions) with ordinality o(x, i) order by i) || d.version;
  v_target := array_position(v_order, p_to_version);
  if v_target is null then
    raise exception 'Workflow % has no version % to migrate to (the active version or an inactive one).', d.name, p_to_version;
  end if;
  v_steps := case when p_to_version = d.version then d.steps
                  else (select x->'steps' from jsonb_array_elements(d.inactive_versions) x where x->>'version' = p_to_version limit 1) end;

  foreach v_id in array (select array_agg(distinct x order by x) from unnest(p_ids) x) loop
    select wf.id, wf.app_id, wf.definition_id, coalesce(wf.version, '1') as version, wf.state, wf.current_step, wf.steps, wf.waiting_task,
           (select td.name from task tk join task_definition td on td.id = tk.definition_id where tk.id = wf.waiting_task) as task_name
      into w from workflow wf where wf.id = v_id for update;
    -- the main path
    workflow_id := v_id;
    branch := null;
    from_version := w.version;
    from_step := w.current_step;
    to_step := case when w.current_step is not null then p_map->>w.current_step end;
    problem := null;
    if w.id is null or w.definition_id is distinct from d.id or w.app_id <> d.app_id then
      problem := 'not an instance of this workflow';
      from_version := null;
      from_step := null;
      to_step := null;
    elsif w.state not in ('active', 'waiting', 'faulted') then
      problem := format('is %s', w.state);
    elsif coalesce(array_position(v_order, w.version), 0) >= v_target then
      problem := format('runs version %s, which is not older than %s', w.version, p_to_version);
    else
      problem := meta.workflow_position_problem(w.state, w.steps, w.current_step, v_steps, to_step, w.waiting_task, w.task_name, p_to_version);
    end if;
    if problem is not null then
      v_bad := v_bad || format('%s %s', v_id, problem);
    end if;
    v_rows := v_rows || jsonb_build_object('id', v_id, 'branch_id', null, 'branch', null, 'from_version', from_version, 'from_step', from_step, 'to_step', to_step);
    return next;
    continue when w.id is null or w.definition_id is distinct from d.id or w.app_id <> d.app_id
               or w.state not in ('active', 'waiting', 'faulted') or coalesce(array_position(v_order, w.version), 0) >= v_target;

    -- (144) each open branch, at a step of its own; its join and split through the mapping
    for b in
      select br.id, br.name, br.state, br.current_step, br.waiting_task, br.split_step, br.join_step,
             (select td.name from task tk join task_definition td on td.id = tk.definition_id where tk.id = br.waiting_task) as task_name
        from workflow_branch br where br.workflow_id = v_id and br.state in ('active', 'waiting', 'faulted') order by br.id
    loop
      branch := b.name;
      from_step := b.current_step;
      to_step := case when b.current_step is not null then p_map->>b.current_step end;
      v_join := coalesce(nullif(p_map->>b.join_step, ''), b.join_step);
      -- the parallel step that split it: mapped, else the one step of the new version that joins at its new join
      v_split := coalesce(nullif(p_map->>b.split_step, ''),
                          (select min(s->>'name') from jsonb_array_elements(v_steps) s where s->>'type' = 'parallel' and s->>'join' = v_join
                            having count(*) = 1),
                          b.split_step);
      problem := meta.workflow_position_problem(b.state, w.steps, b.current_step, v_steps, to_step, b.waiting_task, b.task_name, p_to_version);
      if problem is null and not exists (select 1 from jsonb_array_elements(v_steps) s where s->>'name' = v_join and s->>'type' = 'join') then
        problem := format('ends at the join %s: version %s has no join step %s', b.join_step, p_to_version, v_join);
      elsif problem is null and to_step = v_join then
        problem := format('a branch can''t be mapped onto its own join %s', v_join);
      end if;
      if problem is not null then
        v_bad := v_bad || format('%s (branch %s) %s', v_id, b.name, problem);
      end if;
      v_rows := v_rows || jsonb_build_object('id', v_id, 'branch_id', b.id, 'branch', b.name, 'from_version', w.version, 'from_step', b.current_step,
                                             'to_step', to_step, 'join', v_join, 'split', v_split);
      from_version := w.version;
      return next;
    end loop;
  end loop;

  if not p_apply then
    return;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'Nothing was migrated: instance %.', array_to_string(v_bad, '; instance ');
  end if;
  for r in select * from jsonb_array_elements(v_rows) loop
    if r->>'branch_id' is null then
      update workflow set steps = v_steps, version = p_to_version, current_step = r->>'to_step', updated_at = now()
       where id = (r->>'id')::bigint;
      perform meta.workflow_log((r->>'id')::bigint, r->>'to_step', 'migrated',
        format('version %s → %s: %s → %s (by %s)', r->>'from_version', p_to_version, r->>'from_step', r->>'to_step', p_by));
    else
      update workflow_branch set current_step = r->>'to_step', updated_at = now() where id = (r->>'branch_id')::bigint;
      perform meta.workflow_log((r->>'id')::bigint, r->>'to_step', 'migrated',
        format('version %s → %s: branch %s: %s → %s (by %s)', r->>'from_version', p_to_version, r->>'branch', r->>'from_step', r->>'to_step', p_by));
    end if;
  end loop;
  -- every branch of a moved instance (done ones too: a join counts them) ends at and was split by the mapped steps
  update workflow_branch br
     set join_step = j.name,
         split_step = coalesce(nullif(p_map->>br.split_step, ''),
                               (select min(s->>'name') from jsonb_array_elements(v_steps) s where s->>'type' = 'parallel' and s->>'join' = j.name
                                 having count(*) = 1),
                               br.split_step)
    from (select b2.id, coalesce(nullif(p_map->>b2.join_step, ''), b2.join_step) as name from workflow_branch b2) j
   where j.id = br.id and br.workflow_id in (select distinct (x->>'id')::bigint from jsonb_array_elements(v_rows) x);
  insert into workflow_migration (app_id, definition_name, to_version, mapping, workflow_ids, detail, migrated_by)
  values (d.app_id, d.name, p_to_version, coalesce(p_map, '{}'),
          array(select distinct (x->>'id')::bigint from jsonb_array_elements(v_rows) x order by 1), v_rows, p_by);
  -- active ones go on with their new step
  perform pg_notify('pgkiln_workflow', 'migrated');
end
$$;
revoke all on function meta.migrate_workflows(int, text, bigint[], jsonb, boolean, text) from public;
