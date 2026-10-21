/** ENG04 typed repeat writer repair. Additive successor to 264501/250003.
 * No old SQL, trigger, grants, history, or native/admission ownership is removed.
 * The application still authenticates and validates with the shared schemas and
 * holds the existing live-authority / workspace / Stop-admission locks. This
 * database protocol is not an authentication API for untrusted SQL clients.
 */
export const repeatWriterMigrationSql = String.raw`
-- This is an exact publication witness, not a session setting or a bypass bit.
-- An unconverted UPDATE has no witness. Even a direct witness INSERT must pass
-- the same structural checks and cannot COMMIT without its exact new receipt.
create table repeat_workflow_publications (
  workflow_version_id text primary key references workflow_versions(id),
  workspace_id text not null references workspaces(id),
  workflow_id text not null references workflows(id),
  base_version_id text not null references workflow_versions(id),
  expected_revision bigint not null check (expected_revision between 1 and 9007199254740990),
  principal_id text not null references management_principals(id),
  command_id text not null check (command_id<>''),
  source text not null check (source in ('http','mcp')),
  input_hash text not null check (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  input jsonb not null,
  content_json text not null check (octet_length(content_json)<=4194304),
  publication_xid xid8 not null default pg_current_xact_id(),
  unique (principal_id,command_id),
  unique (workflow_id,expected_revision),
  unique (workflow_id,publication_xid)
);

-- Same presentation omissions as the repeat authoring service: names/descriptions
-- may have been changed by management; geometry is independent of execution.
-- Order and every unclassified field remain meaningful. Repeat is NOT omitted.
create function eng04_repeat_executable_graph(graph jsonb) returns jsonb
language sql immutable strict security invoker as $$
  select (graph - array['name','description','version','createdAt','updatedAt','nodes'])
    || jsonb_build_object('nodes', (select coalesce(jsonb_agg(
      node - array['position','width','height'] order by ordinal),'[]'::jsonb)
      from jsonb_array_elements(graph->'nodes') with ordinality as n(node,ordinal)))
$$;

-- Defense in depth for raw SQL candidates. Only repeat is newly authored; the
-- immutable v2 topology / approval / pins are reused, not reimplemented here.
-- These repeat-specific checks mirror RepeatWorkflowVersionV1Schema in A0.
create function eng04_validate_repeat_plan(graph jsonb) returns void
language plpgsql security invoker as $$
declare
  plan jsonb := graph->'repeat'; block jsonb; members text[];
  seen_blocks text[] := array[]::text[]; seen_members text[] := array[]::text[];
  outcomes jsonb; again jsonb; early jsonb; cap numeric; required numeric;
begin
  if (jsonb_typeof(graph->'nodes')='array' and jsonb_typeof(graph->'edges')='array'
    and jsonb_typeof(plan)='object' and plan->'contractVersion'='1'::jsonb
    and (plan - array['contractVersion','blocks'])='{}'::jsonb
    and jsonb_typeof(plan->'blocks')='array') is not true then
    raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
  end if;
  if jsonb_array_length(plan->'blocks') not between 1 and 1000
    or jsonb_array_length(graph->'nodes') not between 1 and 1000
    or jsonb_array_length(graph->'edges')>8000 then
    raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
  end if;
  required := jsonb_array_length(graph->'nodes');
  for block in select value from jsonb_array_elements(plan->'blocks') loop
    if (jsonb_typeof(block)='object'
      and block ?& array['id','nodeIds','entryNodeId','exitNodeId','maxOccurrences','repeatOutcome','earlyExitOutcome','limitExit']
      and (block - array['id','nodeIds','entryNodeId','exitNodeId','maxOccurrences','repeatOutcome','earlyExitOutcome','limitExit'])='{}'::jsonb
      and jsonb_typeof(block->'id')='string' and block->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      and jsonb_typeof(block->'nodeIds')='array'
      and jsonb_typeof(block->'entryNodeId')='string' and jsonb_typeof(block->'exitNodeId')='string'
      and jsonb_typeof(block->'maxOccurrences')='number'
      and jsonb_typeof(block->'repeatOutcome')='string' and jsonb_typeof(block->'earlyExitOutcome')='string'
      and block->>'repeatOutcome'<>block->>'earlyExitOutcome') is not true then
      raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
    end if;
    cap := (block->>'maxOccurrences')::numeric;
    if cap<>trunc(cap) or cap not between 1 and 2147483647
      or jsonb_array_length(block->'nodeIds') not between 1 and 1000
      or exists(select 1 from jsonb_array_elements(block->'nodeIds') n
        where (jsonb_typeof(n)='string' and n #>> '{}' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$') is not true) then
      raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
    end if;
    select array_agg(value) into members from jsonb_array_elements_text(block->'nodeIds');
    if block->>'id'=any(seen_blocks) or members && seen_members
      or cardinality(members)<>(select count(distinct m) from unnest(members) m)
      or not (block->>'entryNodeId'=any(members) and block->>'exitNodeId'=any(members))
      or exists(select 1 from unnest(members) m where not exists(
        select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=m)) then
      raise exception 'REPEAT_SCOPE_INVALID' using errcode='PGR03';
    end if;
    seen_blocks := array_append(seen_blocks,block->>'id');
    seen_members := seen_members || members;
    -- UNION, not UNION ALL: reachability terminates even on a corrupt base cycle.
    if exists(with recursive reach(direction,id) as (
      select false,block->>'entryNodeId' union select true,block->>'exitNodeId'
      union select r.direction,case when r.direction then e->>'source' else e->>'target' end
        from reach r join jsonb_array_elements(graph->'edges') e
          on (case when r.direction then e->>'target' else e->>'source' end)=r.id
        where e->>'kind'='execution' and e->>'source'=any(members) and e->>'target'=any(members)
    ) select 1 from unnest(members) m where not exists(select 1 from reach where not direction and id=m)
        or not exists(select 1 from reach where direction and id=m)) then
      raise exception 'REPEAT_SCOPE_MUST_BE_SINGLE_ENTRY_EXIT' using errcode='PGR03';
    end if;
    if exists(select 1 from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution' and (
      (not (e->>'source'=any(members)) and e->>'target'=any(members) and e->>'target'<>block->>'entryNodeId')
      or (e->>'source'=any(members) and not (e->>'target'=any(members)) and e->>'source'<>block->>'exitNodeId')
      or (e->>'source'=block->>'exitNodeId' and e->>'target'=any(members)))) then
      raise exception 'REPEAT_SIDE_ENTRY_OR_EXIT' using errcode='PGR03';
    end if;
    select n #> '{choice,outcomes}' into outcomes from jsonb_array_elements(graph->'nodes') n
      where n->>'id'=block->>'exitNodeId';
    if jsonb_typeof(outcomes) is distinct from 'array' then
      raise exception 'REPEAT_EXIT_REQUIRES_TWO_OUTCOMES' using errcode='PGR03';
    end if;
    if jsonb_array_length(outcomes)<>2 then
      raise exception 'REPEAT_EXIT_REQUIRES_TWO_OUTCOMES' using errcode='PGR03';
    end if;
    select o into again from jsonb_array_elements(outcomes) o where o->>'outcome'=block->>'repeatOutcome';
    select o into early from jsonb_array_elements(outcomes) o where o->>'outcome'=block->>'earlyExitOutcome';
    if again is null or early is null or again->'target' is distinct from block->'limitExit' then
      raise exception 'REPEAT_LIMIT_ROUTE_MISMATCH' using errcode='PGR03';
    end if;
    if exists(select 1 from jsonb_array_elements(graph->'nodes') n,
        jsonb_array_elements(coalesce(n #> '{choice,outcomes}','[]'::jsonb)) o
      where n->>'id'=any(members) and n->>'id'<>block->>'exitNodeId' and o #>> '{target,kind}'='branch_end') then
      raise exception 'REPEAT_INTERIOR_BRANCH_END_UNSUPPORTED' using errcode='PGR03';
    end if;
    required := required + (cap-1)*cardinality(members);
  end loop;
  if jsonb_typeof(graph #> '{executionPolicy,maxNodeExecutions}') is distinct from 'number' then
    raise exception 'REPEAT_EXECUTION_BUDGET_INSUFFICIENT' using errcode='PGR03';
  end if;
  if required>9007199254740991 or (graph #>> '{executionPolicy,maxNodeExecutions}')::numeric<required then
    raise exception 'REPEAT_EXECUTION_BUDGET_INSUFFICIENT' using errcode='PGR03';
  end if;
end $$;

-- Mirrors policy.ts resource matching; a Run-scoped grant cannot publish a
-- workflow. In particular skills:read has a workspace-only resource.
create function eng04_repeat_granted(grants jsonb, action text, workspace text, workflow text)
returns boolean language sql immutable security invoker as $$
  select exists(select 1 from jsonb_array_elements(grants) g
    where jsonb_typeof(g->'actions')='array' and g->'actions' ? action and jsonb_typeof(g->'scope')='object'
      and (not (g->'scope' ? 'workspaceIds') or (workspace is not null and jsonb_typeof(g #> '{scope,workspaceIds}')='array' and g #> '{scope,workspaceIds}' ? workspace))
      and (not (g->'scope' ? 'workflowIds') or (workflow is not null and jsonb_typeof(g #> '{scope,workflowIds}')='array' and g #> '{scope,workflowIds}' ? workflow))
      and not (g->'scope' ? 'runIds'))
$$;

create function eng04_check_repeat_publication() returns trigger
language plpgsql security invoker as $$
declare
  current_workflow workflows%rowtype; base workflow_versions%rowtype; candidate workflow_versions%rowtype;
  principal management_principals%rowtype; config agent_configuration_versions%rowtype; pin record;
  graph jsonb; action text; authority_id text := NEW.principal_id; seen text[] := array[]::text[];
  authority_grants jsonb[] := array[]::jsonb[]; grants jsonb;
begin
  if new.publication_xid<>pg_current_xact_id() then
    raise exception 'REPEAT_TYPED_WRITER_REQUIRED' using errcode='PGR01';
  end if;
  -- Same command namespace/order as PostgresCommandCoordinator; no new receipt
  -- can be confused with a historical replay. The service reauthorizes replay.
  perform pg_advisory_xact_lock(hashtext('command:'||new.principal_id||':repeat.save:'||new.command_id));
  -- Requiring each ancestor's grant for this exact resource is equivalent to
  -- the live service's scope intersection, without persisting derived authority.
  while authority_id is not null loop
    if authority_id=any(seen) or cardinality(seen)>=16 then
      raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
    end if;
    seen := array_append(seen,authority_id);
    select * into principal from management_principals where id=authority_id for share;
    if not found or principal.audience<>'operator' or principal.revoked_at is not null
      or principal.expires_at<=clock_timestamp() or jsonb_typeof(principal.grants) is distinct from 'array' then
      raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
    end if;
    foreach action in array array['workflows:read','workflows:update','graph:read','graph:edit','graph:save','agents:read'] loop
      if not eng04_repeat_granted(principal.grants,action,new.workspace_id,new.workflow_id) then
        raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
      end if;
    end loop;
    authority_grants := array_append(authority_grants,principal.grants);
    authority_id := principal.delegated_from;
  end loop;
  if exists(select 1 from management_command_receipts where principal_id=new.principal_id
    and operation='repeat.save' and command_id=new.command_id) then
    raise exception 'REPEAT_RECEIPT_ALREADY_EXISTS' using errcode='PGR04';
  end if;
  perform 1 from workspaces where id=new.workspace_id and archived_at is null for share;
  if not found then raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02'; end if;
  select * into current_workflow from workflows where id=new.workflow_id and workspace_id=new.workspace_id for update;
  if not found or current_workflow.archived_at is not null
    or current_workflow.revision<>new.expected_revision or current_workflow.current_version_id is distinct from new.base_version_id then
    raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02';
  end if;
  select * into base from workflow_versions where id=new.base_version_id for share;
  if not found or base.execution_semantics_version not in (2,3)
    or base.workspace_id<>new.workspace_id or base.workflow_id<>new.workflow_id
    or (base.record->'executionSemanticsVersion'=to_jsonb(base.execution_semantics_version)
      and base.record->>'id'=base.id and base.record->>'workspaceId'=base.workspace_id and base.record->>'workflowId'=base.workflow_id
      and base.record->'version'=to_jsonb(base.version) and base.record->>'entryNodeId'=base.entry_node_id
      and base.record #> '{definition,version}'=to_jsonb(base.version)
      and base.record #> '{definition,executionSemanticsVersion}'=to_jsonb(base.execution_semantics_version)
      and base.record #>> '{definition,id}'=base.workflow_id and base.record #>> '{definition,workspaceId}'=base.workspace_id
      and base.record #>> '{definition,entryNodeId}'=base.entry_node_id
      and base.record #> '{definition,approval}'=base.record->'approval'
      and jsonb_typeof(base.record->'agentConfigurationVersionIds')='object') is not true then
    raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02';
  end if;
  select * into candidate from workflow_versions where id=new.workflow_version_id for share;
  if not found then raise exception 'REPEAT_IMMUTABLE_VERSION_MISMATCH' using errcode='PGR02'; end if;
  graph := candidate.record->'definition';
  if (candidate.execution_semantics_version=3 and candidate.id<>base.id
    and candidate.workspace_id=base.workspace_id and candidate.workflow_id=base.workflow_id
    and candidate.entry_node_id=base.entry_node_id and candidate.version>base.version
    and candidate.version=(select coalesce(max(version),0)+1 from workflow_versions where workflow_id=new.workflow_id and id<>candidate.id)
    and candidate.record->'executionSemanticsVersion'='3'::jsonb
    and candidate.record->>'id'=candidate.id and candidate.record->>'workspaceId'=candidate.workspace_id
    and candidate.record->>'workflowId'=candidate.workflow_id and candidate.record->>'entryNodeId'=candidate.entry_node_id
    and candidate.record->'version'=to_jsonb(candidate.version)
    and graph->'executionSemanticsVersion'='3'::jsonb and graph->'version'=to_jsonb(candidate.version)
    and graph->>'id'=new.workflow_id and graph->>'workspaceId'=new.workspace_id and graph->>'entryNodeId'=candidate.entry_node_id
    and graph->'approval'=candidate.record->'approval'
    and (candidate.record - array['id','version','definition','createdAt','contentHash','executionSemanticsVersion'])
      =(base.record - array['id','version','definition','createdAt','contentHash','executionSemanticsVersion'])
    and current_workflow.record->'version'=to_jsonb(base.version)
    and eng04_repeat_executable_graph(current_workflow.record)=eng04_repeat_executable_graph(base.record->'definition')
    and (graph - array['version','executionSemanticsVersion','repeat','createdAt','updatedAt'])
      =(current_workflow.record - array['version','executionSemanticsVersion','repeat','createdAt','updatedAt'])
    and graph->'createdAt' is not distinct from base.record #> '{definition,createdAt}'
    and graph->'updatedAt'=candidate.record->'createdAt') is not true then
    raise exception 'REPEAT_IMMUTABLE_VERSION_MISMATCH' using errcode='PGR02';
  end if;
  if new.input is distinct from jsonb_build_object(
    'workspaceId',new.workspace_id,'workflowId',new.workflow_id,'commandId',new.command_id,
    'expectedRevision',new.expected_revision,'expectedWorkflowVersionId',new.base_version_id,
    'executionSemanticsVersion',3,'repeat',graph->'repeat')
    or new.content_json::jsonb is distinct from jsonb_build_object('definition',graph,
      'configurations',candidate.record->'agentConfigurationVersionIds','entryNodeId',candidate.entry_node_id)
    or candidate.record->>'contentHash' is distinct from 'sha256:'||encode(sha256(convert_to(new.content_json,'UTF8')),'hex') then
    raise exception 'REPEAT_IMMUTABLE_VERSION_MISMATCH' using errcode='PGR02';
  end if;
  perform eng04_validate_repeat_plan(graph);
  if (select count(*) from jsonb_object_keys(candidate.record->'agentConfigurationVersionIds'))<>jsonb_array_length(graph->'nodes') then
    raise exception 'REPEAT_CONFIGURATION_PIN_MISMATCH' using errcode='PGR02';
  end if;
  for pin in select key,value from jsonb_each_text(candidate.record->'agentConfigurationVersionIds') order by value loop
    select * into config from agent_configuration_versions where id=pin.value and agent_id=pin.key and workspace_id=new.workspace_id for share;
    if not found or config.record->>'id' is distinct from config.id or config.record->>'workspaceId' is distinct from config.workspace_id
      or config.record->>'agentId' is distinct from config.agent_id
      or not exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'agentId'=pin.key) then
      raise exception 'REPEAT_CONFIGURATION_PIN_MISMATCH' using errcode='PGR02';
    end if;
    foreach grants in array authority_grants loop
      if jsonb_array_length(coalesce(config.record->'assignedSkills','[]'::jsonb))>0
        and not eng04_repeat_granted(grants,'skills:read',new.workspace_id,null) then
        raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
      end if;
      if config.record #>> '{harness,harness}'='codex' and config.record #>> '{harness,sandbox}'='danger-full-access'
        and not eng04_repeat_granted(grants,'harnesses:update',new.workspace_id,new.workflow_id) then
        raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
      end if;
    end loop;
  end loop;
  return new;
end $$;
create trigger eng04_repeat_publication_validated before insert on repeat_workflow_publications
  for each row execute function eng04_check_repeat_publication();

-- Narrow invoker operation; it never sets graphql.approval_writer, elevates a
-- role, edits an approval, fabricates Stop settlement, or issues a command receipt.
create function eng04_publish_repeat_workflow(principal text, source text, input jsonb,
  input_hash text, version_id text, content_json text) returns bigint
language plpgsql security invoker as $$
declare published_revision bigint;
begin
  insert into repeat_workflow_publications(workflow_version_id,workspace_id,workflow_id,base_version_id,
    expected_revision,principal_id,command_id,source,input_hash,input,content_json)
  values(version_id,input->>'workspaceId',input->>'workflowId',input->>'expectedWorkflowVersionId',
    (input->>'expectedRevision')::bigint,principal,input->>'commandId',source,input_hash,input,content_json);
  update workflows set current_version_id=version_id,
    record=(select record->'definition' from workflow_versions where id=version_id),revision=revision+1
    where id=input->>'workflowId' and workspace_id=input->>'workspaceId'
      and current_version_id=input->>'expectedWorkflowVersionId' and revision=(input->>'expectedRevision')::bigint
    returning revision into published_revision;
  if not found then raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02'; end if;
  return published_revision;
end $$;

-- Replace the FUNCTION, not either registered migration or historical trigger.
-- The two original v1/v2 branches below are retained without relaxing a predicate.
create or replace function wave25_approval_no_downgrade() returns trigger language plpgsql as $$
declare old_graph jsonb; new_graph jsonb; pinned workflow_versions%rowtype;
begin
  if TG_TABLE_NAME='graph_drafts' then
    old_graph=OLD.record->'graph'; new_graph=NEW.record->'graph';
  else old_graph=OLD.record; new_graph=NEW.record; end if;
  if TG_TABLE_NAME='workflows' then
    select * into pinned from workflow_versions where id=NEW.current_version_id;
    if old_graph->>'executionSemanticsVersion'='3' or new_graph->>'executionSemanticsVersion'='3'
      or pinned.execution_semantics_version=3
      or exists(select 1 from workflow_versions where id=OLD.current_version_id and execution_semantics_version=3) then
      if (new_graph->'executionSemanticsVersion'='3'::jsonb and pinned.execution_semantics_version=3
        and pinned.workflow_id=NEW.id and pinned.workspace_id=NEW.workspace_id
        and NEW.id=OLD.id and NEW.workspace_id=OLD.workspace_id) is not true then
        raise exception 'APPROVAL_OLDER_WRITER_REJECTED' using errcode='PGA01';
      end if;
      if NEW.current_version_id is distinct from OLD.current_version_id then
        if new_graph is distinct from pinned.record->'definition' or NEW.revision<>OLD.revision+1
          or (to_jsonb(NEW)-array['record','revision','current_version_id']) is distinct from
             (to_jsonb(OLD)-array['record','revision','current_version_id'])
          or not exists(select 1 from repeat_workflow_publications p where p.workflow_version_id=NEW.current_version_id
            and p.workspace_id=NEW.workspace_id and p.workflow_id=NEW.id and p.base_version_id=OLD.current_version_id
            and p.expected_revision=OLD.revision and p.publication_xid=pg_current_xact_id()) then
          raise exception 'REPEAT_TYPED_WRITER_REQUIRED' using errcode='PGR01';
        end if;
      elsif (old_graph->'executionSemanticsVersion'='3'::jsonb and NEW.revision>=OLD.revision
        and new_graph->'version'=to_jsonb(pinned.version)
        and new_graph->'createdAt' is not distinct from old_graph->'createdAt'
        and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(old_graph)
        and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(pinned.record->'definition')) is not true then
        raise exception 'REPEAT_TYPED_WRITER_REQUIRED' using errcode='PGR01';
      end if;
      return NEW;
    end if;
  elsif old_graph->>'executionSemanticsVersion'='3' or new_graph->>'executionSemanticsVersion'='3' then
    -- No v3 draft-authoring contract is installed by this narrowly owned repair.
    raise exception 'REPEAT_TYPED_WRITER_REQUIRED' using errcode='PGR01';
  end if;
  if old_graph->>'executionSemanticsVersion'='2' and
    (new_graph->>'executionSemanticsVersion' is distinct from '2'
     or not (new_graph ? 'entryNodeId')
     or exists(select 1 from jsonb_array_elements(new_graph->'edges') e
       where e->>'kind' is null or e->>'kind' not in ('execution','approval'))) then
    raise exception 'APPROVAL_OLDER_WRITER_REJECTED' using errcode='PGA01';
  end if;
  if new_graph->>'executionSemanticsVersion'='2' and
    ((old_graph->'approval') is distinct from (new_graph->'approval') or
     (select coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb) from jsonb_array_elements(old_graph->'edges') e where e->>'kind'='approval')
     is distinct from
     (select coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb) from jsonb_array_elements(new_graph->'edges') e where e->>'kind'='approval'))
    and current_setting('graphql.approval_writer',true) is distinct from 'v2' then
    raise exception 'APPROVAL_TYPED_WRITER_REQUIRED' using errcode='PGA04';
  end if;
  return NEW;
end $$;
-- The historical trigger is UPDATE OF record only. Cover pointer-only and scope
-- writes too; record+pointer writes may check twice, with no side effects.
create trigger eng04_repeat_workflow_pin_writer before update of current_version_id,id,workspace_id,revision on workflows
  for each row execute function wave25_approval_no_downgrade();

create function eng04_repeat_publication_committed() returns trigger language plpgsql security invoker as $$
begin
  if not exists(select 1 from management_command_receipts r join workflow_versions v on v.id=NEW.workflow_version_id
    join workflows w on w.id=NEW.workflow_id and w.workspace_id=NEW.workspace_id
    where r.principal_id=NEW.principal_id and r.operation='repeat.save' and r.command_id=NEW.command_id
      and r.target_key='workflow:'||NEW.workflow_id||':repeat' and r.input_hash=NEW.input_hash
      and r.xmin=NEW.publication_xid::xid
      and r.result=jsonb_build_object('workspaceId',NEW.workspace_id,'workflowId',NEW.workflow_id,
        'revision',NEW.expected_revision+1,'currentVersionId',v.id,'version',v.record)
      and w.current_version_id=v.id and w.revision=NEW.expected_revision+1 and w.record=v.record->'definition')
    or not exists(select 1 from management_audit a where a.principal_id=NEW.principal_id and a.source=NEW.source
      and a.action='repeat.save' and a.target_key='workflow:'||NEW.workflow_id||':repeat' and a.outcome='succeeded'
      and a.details->>'commandId'=NEW.command_id and a.xmin=NEW.publication_xid::xid) then
    raise exception 'REPEAT_ATOMIC_RECEIPT_REQUIRED' using errcode='PGR04';
  end if;
  return NEW;
end $$;
create constraint trigger eng04_repeat_publication_receipt after insert on repeat_workflow_publications
  deferrable initially deferred for each row execute function eng04_repeat_publication_committed();
create function eng04_repeat_publication_immutable() returns trigger language plpgsql security invoker as $$
begin raise exception 'REPEAT_PUBLICATION_IMMUTABLE' using errcode='PGR06'; end $$;
create trigger eng04_repeat_publication_immutable before update or delete on repeat_workflow_publications
  for each row execute function eng04_repeat_publication_immutable();
create trigger eng04_repeat_publication_no_truncate before truncate on repeat_workflow_publications
  for each statement execute function eng04_repeat_publication_immutable();

-- Bind table/function resolution to the schema that owns this installation.
-- Explicit pg_temp LAST prevents a temporary namesake from supplying a witness.
-- SECURITY INVOKER and all existing ACLs remain unchanged; no grants are issued.
do $$ declare f record; installed_schema text := current_schema(); begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=installed_schema and p.proname in ('eng04_repeat_executable_graph','eng04_validate_repeat_plan',
      'eng04_repeat_granted','eng04_check_repeat_publication','eng04_publish_repeat_workflow',
      'wave25_approval_no_downgrade','eng04_repeat_publication_committed','eng04_repeat_publication_immutable') loop
    execute format('alter function %s set search_path to pg_catalog, %I, pg_temp',f.signature,installed_schema);
  end loop;
end $$;
`

export const repeatWriterMigration = { version: 264502, sql: repeatWriterMigrationSql } as const
