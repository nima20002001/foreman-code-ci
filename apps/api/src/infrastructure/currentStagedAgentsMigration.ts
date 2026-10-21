const currentWorkflowPublicationCommittedSql = String.raw`create function eng04_current_publication_committed() returns trigger language plpgsql security invoker as $$
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
        'revision',NEW.expected_revision+1,'currentVersionId',v.id,'version',v.record) ||
        case when jsonb_array_length(coalesce(NEW.input->'stagedAgents','[]'::jsonb))>0 then
          jsonb_build_object('agents',(select jsonb_agg(jsonb_build_object('agent',a.record,'metadataRevision',a.metadata_revision) order by x.ordinal)
            from jsonb_array_elements(NEW.input->'stagedAgents') with ordinality x(value,ordinal)
            join agents a on a.id=x.value #>> '{agent,id}' and a.workspace_id=NEW.workspace_id))
        else '{}'::jsonb end
      and w.current_version_id=v.id and w.revision=NEW.expected_revision+1 and w.record=v.record->'definition')
    or not exists(select 1 from management_audit a where a.principal_id=NEW.principal_id and a.source=NEW.source
      and a.action='workflow.save.v3' and a.target_key='workflow:'||NEW.workflow_id||':definition' and a.outcome='succeeded'
      and a.details->>'commandId'=NEW.command_id and a.xmin=NEW.publication_xid::xid) then
    raise exception 'CURRENT_ATOMIC_RECEIPT_REQUIRED' using errcode='PGC04';
  end if;
  return NEW;
end $$;
`

const currentWorkflowPublicationValidationSql = String.raw`create function eng04_check_current_publication() returns trigger language plpgsql security invoker as $$
declare
  workflow workflows%rowtype; candidate workflow_versions%rowtype; base workflow_versions%rowtype;
  principal management_principals%rowtype; config agent_configuration_versions%rowtype; pin record;
  graph jsonb; action text; authority text := NEW.principal_id; seen text[] := array[]::text[];
  staged jsonb; journal jsonb; updated_agent agents%rowtype; prior_config agent_configuration_versions%rowtype;
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
      'expectedAgentConfigurationVersionIds','expectedLocationRevision','graph','commandId','stagedAgents','resultantAgentConfigurationVersionIds'])='{}'::jsonb
    and NEW.input #> '{graph,version}' is not distinct from workflow.record->'version'
    and (eng04_preserve_current_geometry(NEW.input->'graph',workflow.record) - array['version','updatedAt'])=(graph - array['version','updatedAt'])
    and coalesce(NEW.input->'resultantAgentConfigurationVersionIds',NEW.input->'expectedAgentConfigurationVersionIds')=candidate.record->'agentConfigurationVersionIds'
    and NEW.content_json::jsonb=jsonb_build_object('definition',graph,'configurations',candidate.record->'agentConfigurationVersionIds','entryNodeId',candidate.entry_node_id)
    and candidate.record->>'contentHash'='sha256:'||encode(sha256(convert_to(NEW.content_json,'UTF8')),'hex')) is not true then
    raise exception 'CURRENT_VERSION_INVALID' using errcode='PGC02';
  end if;
  if NEW.input ? 'stagedAgents' and jsonb_array_length(NEW.input->'stagedAgents')>0 then
    select i.record into journal from graph_edit_intents i where i.principal_id=NEW.principal_id
      and i.workspace_id=NEW.workspace_id and i.workflow_id=NEW.workflow_id and i.state='saving'
      and i.record->>'kind'='current' and i.record->'saveAttempted'='true'::jsonb
      and i.record->'saveInput'=NEW.input and i.record->>'saveInputHash'=NEW.input_hash for share;
    if not found or journal #> '{stagedDraft,resultantAgentConfigurationVersionIds}' is distinct from candidate.record->'agentConfigurationVersionIds'
      or journal #> '{stagedDraft,agentConfigurationVersionIds}' is distinct from NEW.input->'expectedAgentConfigurationVersionIds'
      or journal #> '{stagedDraft,stagedAgents}' is distinct from NEW.input->'stagedAgents'
      or not exists(select 1 from management_audit audit where audit.principal_id=NEW.principal_id
        and audit.action='graph.edit_stop_tracking' and audit.target_key='edit-intent:'||(journal->>'id')) then
      raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
    end if;
    if jsonb_array_length(NEW.input->'stagedAgents')<>(select count(distinct x #>> '{agent,id}') from jsonb_array_elements(NEW.input->'stagedAgents') x) then
      raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
    end if;
    for staged in select value from jsonb_array_elements(NEW.input->'stagedAgents') loop
      select * into updated_agent from agents where id=staged #>> '{agent,id}' and workspace_id=NEW.workspace_id for share;
      if not found or updated_agent.archived_at is not null
        or updated_agent.current_configuration_version_id is distinct from candidate.record->'agentConfigurationVersionIds'->>(staged #>> '{agent,id}')
        or updated_agent.record->>'name' is distinct from staged #>> '{agent,name}'
        or updated_agent.metadata_revision<>coalesce((staged->>'baseRevision')::bigint,0)+1
        or updated_agent.current_configuration_version_id<>'staged-config-'||encode(sha256(convert_to(NEW.command_id||':'||updated_agent.id,'UTF8')),'hex')
        or not exists(select 1 from jsonb_array_elements(journal->'agentPins') p where p->>'agentId'=updated_agent.id
          and p->'metadataRevision'=staged->'baseRevision'
          and p->'configurationVersionId'=coalesce(NEW.input->'expectedAgentConfigurationVersionIds'->updated_agent.id,'null'::jsonb)) then
        raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
      end if;
      if staged->'baseRevision'='null'::jsonb then
        if NEW.input->'expectedAgentConfigurationVersionIds' ? updated_agent.id or staged->'agent' ? 'configurationVersionId' then
          raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
        end if;
      else
        select * into prior_config from agent_configuration_versions where id=NEW.input->'expectedAgentConfigurationVersionIds'->>updated_agent.id
          and workspace_id=NEW.workspace_id and agent_id=updated_agent.id;
        if not found or staged #>> '{agent,configurationVersionId}' is distinct from prior_config.id then
          raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
        end if;
      end if;
      foreach grants in array all_grants loop
        if not eng04_repeat_granted(grants,case when staged->'baseRevision'='null'::jsonb then 'agents:create' else 'agents:update' end,NEW.workspace_id,null)
          or (updated_agent.record #>> '{harnessConfiguration,harness}'='codex'
            and updated_agent.record #>> '{harnessConfiguration,sandbox}'='danger-full-access'
            and not eng04_repeat_granted(grants,'harnesses:update',NEW.workspace_id,null))
          or exists(select 1 from workflows w where w.workspace_id=NEW.workspace_id and exists(
            select 1 from jsonb_array_elements(w.record->'nodes') n where n->>'agentId'=updated_agent.id)
            and (not eng04_repeat_granted(grants,'graph:read',NEW.workspace_id,w.id)
              or not eng04_repeat_granted(grants,'graph:edit',NEW.workspace_id,w.id))) then
          raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
        end if;
      end loop;
    end loop;
    if exists(select 1 from jsonb_each_text(candidate.record->'agentConfigurationVersionIds') p
      where not exists(select 1 from jsonb_array_elements(NEW.input->'stagedAgents') x where x #>> '{agent,id}'=p.key)
        and p.value is distinct from NEW.input->'expectedAgentConfigurationVersionIds'->>p.key)
      or exists(select 1 from jsonb_object_keys(NEW.input->'expectedAgentConfigurationVersionIds') k
        where not (candidate.record->'agentConfigurationVersionIds' ? k)) then
      raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
    end if;
  elsif NEW.input ? 'resultantAgentConfigurationVersionIds' then
    raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
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
  if exists(select 1 from runs r where r.workspace_id=NEW.workspace_id and (r.workflow_id=NEW.workflow_id or exists(select 1 from jsonb_array_elements(coalesce(NEW.input->'stagedAgents','[]'::jsonb)) x
      where r.record->'agentConfigurationVersionIds' ? (x #>> '{agent,id}')))
    and (r.execution_state<>'completed' or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending))) then
    raise exception 'CURRENT_RUNS_UNSETTLED' using errcode='PGC02';
  end if;
  return NEW;
end $$;
`

/** Upgrade the same typed writer for private staged Agent publication. */
export const currentStagedAgentsMigration = { version: 264604, sql: currentWorkflowPublicationValidationSql.replace(
  'create function eng04_check_current_publication()', 'create or replace function eng04_check_current_publication()')
  + currentWorkflowPublicationCommittedSql.replace('create function eng04_current_publication_committed()', 'create or replace function eng04_current_publication_committed()')
  + String.raw`
do $$ declare installed_schema text := current_schema(); begin
  execute format('alter function eng04_check_current_publication() set search_path to pg_catalog, %I, pg_temp', installed_schema);
  execute format('alter function eng04_current_publication_committed() set search_path to pg_catalog, %I, pg_temp', installed_schema);
end $$;
` }
