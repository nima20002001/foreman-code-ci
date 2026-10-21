/** Current v3 authoring witness. This is NOT a second Run projection or engine.
 * Existing immutable versions, Run pins, old witnesses and all ACLs survive.
 * Only the shell applies migrations; no session setting authorizes this writer. */
export const currentWorkflowWriterMigration = { version: 264601, sql: String.raw`
create table current_workflow_publications (
  workflow_version_id text primary key references workflow_versions(id),
  workspace_id text not null references workspaces(id),
  workflow_id text not null references workflows(id),
  base_version_id text references workflow_versions(id),
  expected_revision bigint not null check(expected_revision between 1 and 9007199254740990),
  principal_id text not null references management_principals(id),
  command_id text not null check(command_id<>''), source text not null check(source in ('http','mcp')),
  input_hash text not null check(input_hash ~ '^sha256:[0-9a-f]{64}$'), input jsonb not null,
  content_json text not null check(octet_length(content_json)<=4194304),
  publication_xid xid8 not null default pg_current_xact_id(),
  unique(principal_id,command_id), unique(workflow_id,expected_revision), unique(workflow_id,publication_xid)
);

-- Ordinary V3 omits repeat. Present repeat retains the original nonempty,
-- bounded validator; no empty plan, session flag or fake cap-one block is added.
-- Retained versions keep their original semantics; current publication requires 3.
-- Remove the mandatory-repeat constraint only for current authored versions.
alter table workflow_versions drop constraint workflow_versions_execution_semantics_version_check;
alter table workflow_versions add constraint workflow_versions_execution_semantics_version_check
  check (execution_semantics_version in (1,2,3));
alter table workflow_versions alter column execution_semantics_version set default 3;
alter table workflow_versions drop constraint repeat_version_record_pin;
alter table workflow_versions add constraint repeat_version_record_pin check (
  execution_semantics_version<>3 or ((record->'executionSemanticsVersion'='3'::jsonb
    and record #> '{definition,executionSemanticsVersion}'='3'::jsonb
    and record->>'id'=id and record->>'workspaceId'=workspace_id and record->>'workflowId'=workflow_id
    and case when not (record->'definition' ? 'repeat') then true
      when jsonb_typeof(record #> '{definition,repeat}')='object'
        and record #> '{definition,repeat,contractVersion}'='1'::jsonb
        and jsonb_typeof(record #> '{definition,repeat,blocks}')='array'
      then jsonb_array_length(record #> '{definition,repeat,blocks}') between 1 and 1000
      else false end) is true));

create function eng04_validate_current_graph(graph jsonb) returns void
language plpgsql security invoker as $$
declare edge jsonb; node jsonb; declaration jsonb; entry text := graph->>'entryNodeId';
begin
  if (graph->'executionSemanticsVersion'='3'::jsonb and jsonb_typeof(graph->'nodes')='array'
    and jsonb_typeof(graph->'edges')='array' and jsonb_typeof(graph->'entryNodeId')='string') is not true then
    raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
  end if;
  if jsonb_array_length(graph->'nodes') not between 1 and 1000 or jsonb_array_length(graph->'edges')>8000 then
    raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
  end if;
  if (jsonb_typeof(graph->'executionPolicy')='object'
    and jsonb_typeof(graph #> '{executionPolicy,maxParallelism}')='number'
    and jsonb_typeof(graph #> '{executionPolicy,maxNodeExecutions}')='number') is not true then
    raise exception 'CURRENT_EXECUTION_POLICY_INVALID' using errcode='PGC03';
  end if;
  if (graph #>> '{executionPolicy,maxParallelism}')::numeric<1
    or (graph #>> '{executionPolicy,maxParallelism}')::numeric<>trunc((graph #>> '{executionPolicy,maxParallelism}')::numeric)
    or (graph #>> '{executionPolicy,maxNodeExecutions}')::numeric<jsonb_array_length(graph->'nodes')
    or (graph #>> '{executionPolicy,maxNodeExecutions}')::numeric<>trunc((graph #>> '{executionPolicy,maxNodeExecutions}')::numeric) then
    raise exception 'CURRENT_EXECUTION_POLICY_INVALID' using errcode='PGC03';
  end if;
  if graph ? 'repeat' then perform eng04_validate_repeat_plan(graph); end if;
  if jsonb_array_length(graph->'nodes')<>(select count(distinct n->>'id') from jsonb_array_elements(graph->'nodes') n)
    or jsonb_array_length(graph->'nodes')<>(select count(distinct n->>'agentId') from jsonb_array_elements(graph->'nodes') n)
    or jsonb_array_length(graph->'edges')<>(select count(distinct e->>'id') from jsonb_array_elements(graph->'edges') e)
    or not exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=entry) then
    raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
  end if;
  for edge in select value from jsonb_array_elements(graph->'edges') loop
    if (edge->>'kind' in ('execution','approval') and edge->>'source'<>edge->>'target'
      and exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=edge->>'source')
      and exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=edge->>'target')) is not true
      or (edge->>'kind'='execution' and edge->>'target'=entry) then
      raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
    end if;
  end loop;
  -- UNION terminates even for malformed cycles. No execution back-edge is a repeat.
  if exists(with recursive reach(source,target) as (
    select e->>'source',e->>'target' from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution'
    union select r.source,e->>'target' from reach r join jsonb_array_elements(graph->'edges') e
      on e->>'source'=r.target and e->>'kind'='execution'
  ) select 1 from reach where source=target) then
    raise exception 'CURRENT_GRAPH_CYCLE' using errcode='PGC03';
  end if;
  for node in select value from jsonb_array_elements(graph->'nodes') loop
    if node ? 'choice' then
      for declaration in select value from jsonb_array_elements(node #> '{choice,outcomes}') loop
        if declaration #>> '{target,kind}'='edge' and not exists(
          select 1 from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution'
            and e->>'source'=node->>'id' and e->>'id'=declaration #>> '{target,relationshipId}') then
          raise exception 'CURRENT_GRAPH_CHOICE_INVALID' using errcode='PGC03';
        end if;
      end loop;
      if exists(select 1 from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution' and e->>'source'=node->>'id'
        and not exists(select 1 from jsonb_array_elements(node #> '{choice,outcomes}') d where d #>> '{target,relationshipId}'=e->>'id')) then
        raise exception 'CURRENT_GRAPH_CHOICE_INVALID' using errcode='PGC03';
      end if;
    end if;
  end loop;
end $$;

-- Same geometry rule as preserveWorkflowGeometry: retained nodes keep the
-- latest presentation, new nodes keep their authored geometry. Exact staged
-- meaning and command hashes do not change when the board is moved while waiting.
create function eng04_preserve_current_geometry(authored jsonb, current_graph jsonb) returns jsonb
language sql immutable strict security invoker as $$
  select authored || jsonb_build_object('nodes', (
    select coalesce(jsonb_agg(case when p.node is null then n.node else
      (n.node - array['position','width','height']) ||
      (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.node)
        where key in ('position','width','height')) end order by n.ordinal),'[]'::jsonb)
    from jsonb_array_elements(authored->'nodes') with ordinality as n(node,ordinal)
    left join jsonb_array_elements(current_graph->'nodes') as p(node) on p.node->>'id'=n.node->>'id'
  ))
$$;

create function eng04_check_current_publication() returns trigger language plpgsql security invoker as $$
declare
  workflow workflows%rowtype; candidate workflow_versions%rowtype; base workflow_versions%rowtype;
  principal management_principals%rowtype; config agent_configuration_versions%rowtype; pin record;
  graph jsonb; action text; authority text := NEW.principal_id; seen text[] := array[]::text[];
  all_grants jsonb[] := array[]::jsonb[]; grants jsonb; location_revision bigint;
begin
  if NEW.publication_xid<>pg_current_xact_id() then raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01'; end if;
  perform pg_advisory_xact_lock(hashtext('command:'||NEW.principal_id||':workflow.save.v3:'||NEW.command_id));
  while authority is not null loop
    if authority=any(seen) or cardinality(seen)>=16 then raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05'; end if;
    seen := array_append(seen,authority);
    select * into principal from management_principals where id=authority for share;
    if not found or principal.audience<>'operator' or principal.revoked_at is not null or principal.expires_at<=clock_timestamp() then
      raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
    end if;
    foreach action in array array['workflows:read','workflows:update','graph:read','graph:edit','graph:save','agents:read'] loop
      if not eng04_repeat_granted(principal.grants,action,NEW.workspace_id,NEW.workflow_id) then
        raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
      end if;
    end loop;
    if not eng04_repeat_granted(principal.grants,'workspace_locations:read',NEW.workspace_id,null) then
      raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
    end if;
    all_grants := array_append(all_grants,principal.grants); authority := principal.delegated_from;
  end loop;
  perform pg_advisory_xact_lock(hashtext('admission:workspace:'||NEW.workspace_id));
  select w.location_revision into location_revision from workspaces w where w.id=NEW.workspace_id and w.archived_at is null for share;
  if not found or to_jsonb(location_revision) is distinct from NEW.input->'expectedLocationRevision' then
    raise exception 'CURRENT_LOCATION_CONFLICT' using errcode='PGC02';
  end if;
  select * into workflow from workflows where id=NEW.workflow_id and workspace_id=NEW.workspace_id for update;
  if not found or workflow.archived_at is not null or workflow.revision<>NEW.expected_revision
    or workflow.current_version_id is distinct from NEW.base_version_id or workflow.record->'executionSemanticsVersion' is distinct from '3'::jsonb then
    raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02';
  end if;
  if NEW.base_version_id is not null then
    select * into base from workflow_versions where id=NEW.base_version_id for share;
    if not found or base.execution_semantics_version<>3 or base.workspace_id<>NEW.workspace_id or base.workflow_id<>NEW.workflow_id
      or eng04_repeat_executable_graph(workflow.record) is distinct from eng04_repeat_executable_graph(base.record->'definition') then
      raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02';
    end if;
  elsif exists(select 1 from workflow_versions where workflow_id=NEW.workflow_id and id<>NEW.workflow_version_id)
    or workflow.record->'nodes' is distinct from '[]'::jsonb or workflow.record->'edges' is distinct from '[]'::jsonb then
    raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02';
  end if;
  if exists(select 1 from management_command_receipts where principal_id=NEW.principal_id and operation='workflow.save.v3' and command_id=NEW.command_id) then
    raise exception 'CURRENT_RECEIPT_ALREADY_EXISTS' using errcode='PGC04';
  end if;
  select * into candidate from workflow_versions where id=NEW.workflow_version_id for share;
  if not found then raise exception 'CURRENT_VERSION_INVALID' using errcode='PGC02'; end if;
  graph := candidate.record->'definition';
  if (candidate.execution_semantics_version=3 and candidate.workspace_id=NEW.workspace_id and candidate.workflow_id=NEW.workflow_id
    and candidate.id is distinct from NEW.base_version_id
    and candidate.version=(select coalesce(max(version),0)+1 from workflow_versions where workflow_id=NEW.workflow_id and id<>candidate.id)
    and candidate.record->>'id'=candidate.id and candidate.record->>'workspaceId'=NEW.workspace_id and candidate.record->>'workflowId'=NEW.workflow_id
    and candidate.record->'executionSemanticsVersion'='3'::jsonb and candidate.record->'version'=to_jsonb(candidate.version)
    and candidate.record->>'entryNodeId'=candidate.entry_node_id and graph->>'entryNodeId'=candidate.entry_node_id
    and graph->>'id'=NEW.workflow_id and graph->>'workspaceId'=NEW.workspace_id and graph->'version'=to_jsonb(candidate.version)
    and graph->'approval'=candidate.record->'approval'
    and graph->'createdAt' is not distinct from workflow.record->'createdAt' and graph->'updatedAt'=candidate.record->'createdAt'
    and NEW.input->'expectedRevision'=to_jsonb(NEW.expected_revision)
    and NEW.input->'expectedWorkflowVersionId'=coalesce(to_jsonb(NEW.base_version_id),'null'::jsonb)
    and NEW.input->'executionSemanticsVersion'='3'::jsonb and NEW.input->>'commandId'=NEW.command_id
    and NEW.input->>'workspaceId'=NEW.workspace_id and NEW.input->>'workflowId'=NEW.workflow_id
    and (NEW.input - array['workspaceId','workflowId','executionSemanticsVersion','expectedRevision','expectedWorkflowVersionId',
      'expectedAgentConfigurationVersionIds','expectedLocationRevision','graph','commandId'])='{}'::jsonb
    and NEW.input #> '{graph,version}' is not distinct from workflow.record->'version'
    and (eng04_preserve_current_geometry(NEW.input->'graph',workflow.record) - array['version','updatedAt'])=(graph - array['version','updatedAt'])
    and NEW.input->'expectedAgentConfigurationVersionIds'=candidate.record->'agentConfigurationVersionIds'
    and NEW.content_json::jsonb=jsonb_build_object('definition',graph,'configurations',candidate.record->'agentConfigurationVersionIds','entryNodeId',candidate.entry_node_id)
    and candidate.record->>'contentHash'='sha256:'||encode(sha256(convert_to(NEW.content_json,'UTF8')),'hex')) is not true then
    raise exception 'CURRENT_VERSION_INVALID' using errcode='PGC02';
  end if;
  perform eng04_validate_current_graph(graph);
  if (select count(*) from jsonb_object_keys(candidate.record->'agentConfigurationVersionIds'))<>jsonb_array_length(graph->'nodes') then
    raise exception 'CURRENT_CONFIGURATION_CONFLICT' using errcode='PGC02';
  end if;
  for pin in select key,value from jsonb_each_text(candidate.record->'agentConfigurationVersionIds') order by key loop
    select c.* into config from agent_configuration_versions c join agents a on a.id=c.agent_id and a.workspace_id=c.workspace_id
      where c.id=pin.value and c.agent_id=pin.key and c.workspace_id=NEW.workspace_id
        and a.archived_at is null and a.current_configuration_version_id=c.id for share of c,a;
    if not found or config.record->>'id' is distinct from config.id or config.record->>'agentId' is distinct from pin.key
      or config.record->>'workspaceId' is distinct from NEW.workspace_id or config.record->'version' is distinct from to_jsonb(config.version)
      or not exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'agentId'=pin.key) then
      raise exception 'CURRENT_CONFIGURATION_CONFLICT' using errcode='PGC02';
    end if;
    foreach grants in array all_grants loop
      if jsonb_array_length(coalesce(config.record->'assignedSkills','[]'::jsonb))>0 and not eng04_repeat_granted(grants,'skills:read',NEW.workspace_id,null)
        or (config.record #>> '{harness,harness}'='codex' and config.record #>> '{harness,sandbox}'='danger-full-access'
          and not eng04_repeat_granted(grants,'harnesses:update',NEW.workspace_id,NEW.workflow_id)) then
        raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
      end if;
    end loop;
  end loop;
  -- Authoritative closure/approval settlement is checked by saveAdmission.ts on
  -- this locked transaction. This additional guard cannot replace that proof.
  if exists(select 1 from runs r where r.workspace_id=NEW.workspace_id and r.workflow_id=NEW.workflow_id
    and (r.execution_state<>'completed' or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending))) then
    raise exception 'CURRENT_RUNS_UNSETTLED' using errcode='PGC02';
  end if;
  return NEW;
end $$;
create trigger eng04_current_publication_validated before insert on current_workflow_publications
  for each row execute function eng04_check_current_publication();

create function eng04_publish_current_workflow(principal text, source text, input jsonb,
  input_hash text, version_id text, content_json text) returns bigint language plpgsql security invoker as $$
declare revision bigint;
begin
  insert into current_workflow_publications(workflow_version_id,workspace_id,workflow_id,base_version_id,expected_revision,
    principal_id,command_id,source,input_hash,input,content_json)
  values(version_id,input->>'workspaceId',input->>'workflowId',input->>'expectedWorkflowVersionId',(input->>'expectedRevision')::bigint,
    principal,input->>'commandId',source,input_hash,input,content_json);
  update workflows w set record=(select v.record->'definition' from workflow_versions v where v.id=version_id),
    current_version_id=version_id,revision=w.revision+1
    where w.workspace_id=input->>'workspaceId' and w.id=input->>'workflowId'
      and w.revision=(input->>'expectedRevision')::bigint and w.current_version_id is not distinct from input->>'expectedWorkflowVersionId'
    returning w.revision into revision;
  if not found then raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02'; end if;
  return revision;
end $$;

-- Current-only authoring guard. Historical immutable rows remain evidence;
-- they are not a branch through which an old writer can publish current work.
create or replace function wave25_approval_no_downgrade() returns trigger language plpgsql as $$
declare old_graph jsonb := OLD.record; new_graph jsonb := NEW.record; pinned workflow_versions%rowtype;
begin
  if TG_TABLE_NAME<>'workflows' then
    raise exception 'CURRENT_DEFINITION_SERVICE_REQUIRED' using errcode='PGC01';
  end if;
  if (old_graph->'executionSemanticsVersion'='3'::jsonb and new_graph->'executionSemanticsVersion'='3'::jsonb
    and NEW.id=OLD.id and NEW.workspace_id=OLD.workspace_id) is not true then
    raise exception 'EXECUTION_SEMANTICS_UNSUPPORTED' using errcode='PGC01';
  end if;
  select * into pinned from workflow_versions where id=NEW.current_version_id;
  if NEW.current_version_id is distinct from OLD.current_version_id then
    if (pinned.execution_semantics_version=3 and pinned.workflow_id=NEW.id and pinned.workspace_id=NEW.workspace_id
      and NEW.revision=OLD.revision+1 and new_graph=pinned.record->'definition'
      and (to_jsonb(NEW)-array['record','revision','current_version_id'])=(to_jsonb(OLD)-array['record','revision','current_version_id'])
      and exists(select 1 from current_workflow_publications p where p.workflow_version_id=NEW.current_version_id
        and p.workspace_id=NEW.workspace_id and p.workflow_id=NEW.id and p.base_version_id is not distinct from OLD.current_version_id
        and p.expected_revision=OLD.revision and p.publication_xid=pg_current_xact_id())) is not true then
      raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01';
    end if;
  elsif NEW.current_version_id is null then
    if (NEW.revision>=OLD.revision and old_graph->'nodes'='[]'::jsonb and old_graph->'edges'='[]'::jsonb
      and not (new_graph ? 'repeat')
      and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(old_graph)
      and new_graph->'createdAt' is not distinct from old_graph->'createdAt') is not true then
      raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01';
    end if;
  elsif (pinned.execution_semantics_version=3 and pinned.workflow_id=NEW.id and pinned.workspace_id=NEW.workspace_id
    and NEW.revision>=OLD.revision and new_graph->'version'=to_jsonb(pinned.version)
    and new_graph->'createdAt' is not distinct from old_graph->'createdAt'
    and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(old_graph)
    and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(pinned.record->'definition')) is not true then
    raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01';
  end if;
  return NEW;
end $$;

create function eng04_current_publication_committed() returns trigger language plpgsql security invoker as $$
declare principal management_principals%rowtype; authority text := NEW.principal_id; seen text[] := array[]::text[];
begin
  -- Row locks prevent concurrent grant changes; wall-clock expiry still needs
  -- a deferred check before the atomic publication can commit.
  while authority is not null loop
    if authority=any(seen) or cardinality(seen)>=16 then raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05'; end if;
    seen := array_append(seen,authority);
    select * into principal from management_principals where id=authority for share;
    if not found or principal.audience<>'operator' or principal.revoked_at is not null or principal.expires_at<=clock_timestamp() then
      raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
    end if;
    authority := principal.delegated_from;
  end loop;
  if not exists(select 1 from management_command_receipts r join workflow_versions v on v.id=NEW.workflow_version_id
    join workflows w on w.id=NEW.workflow_id and w.workspace_id=NEW.workspace_id
    where r.principal_id=NEW.principal_id and r.operation='workflow.save.v3' and r.command_id=NEW.command_id
      and r.target_key='workflow:'||NEW.workflow_id||':definition' and r.input_hash=NEW.input_hash and r.xmin=NEW.publication_xid::xid
      and r.result=jsonb_build_object('workspaceId',NEW.workspace_id,'workflowId',NEW.workflow_id,
        'revision',NEW.expected_revision+1,'currentVersionId',v.id,'version',v.record)
      and w.current_version_id=v.id and w.revision=NEW.expected_revision+1 and w.record=v.record->'definition')
    or not exists(select 1 from management_audit a where a.principal_id=NEW.principal_id and a.source=NEW.source
      and a.action='workflow.save.v3' and a.target_key='workflow:'||NEW.workflow_id||':definition' and a.outcome='succeeded'
      and a.details->>'commandId'=NEW.command_id and a.xmin=NEW.publication_xid::xid) then
    raise exception 'CURRENT_ATOMIC_RECEIPT_REQUIRED' using errcode='PGC04';
  end if;
  return NEW;
end $$;
create constraint trigger eng04_current_publication_receipt after insert on current_workflow_publications
  deferrable initially deferred for each row execute function eng04_current_publication_committed();
create trigger eng04_current_publication_immutable before update or delete on current_workflow_publications
  for each row execute function eng04_repeat_publication_immutable();
create trigger eng04_current_publication_no_truncate before truncate on current_workflow_publications
  for each statement execute function eng04_repeat_publication_immutable();
do $$ declare f record; installed_schema text := current_schema(); begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=installed_schema and p.proname in ('eng04_validate_current_graph','eng04_preserve_current_geometry','eng04_check_current_publication',
      'eng04_publish_current_workflow','eng04_current_publication_committed','wave25_approval_no_downgrade') loop
    execute format('alter function %s set search_path to pg_catalog, %I, pg_temp',f.signature,installed_schema);
  end loop;
end $$;
` } as const
