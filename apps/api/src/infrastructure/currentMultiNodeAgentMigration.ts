import { currentStagedAgentsMigration } from './currentStagedAgentsMigration.js'
import { currentWorkflowWriterMigration } from './currentWorkflowWriterMigration.js'
/** Remove only the obsolete Agent uniqueness rule. Node identities still remain unique.
 * Existing immutable workflow versions and Run snapshots are not changed. */
const graphValidation = currentWorkflowWriterMigration.sql.slice(
  currentWorkflowWriterMigration.sql.indexOf('create function eng04_validate_current_graph('),
  currentWorkflowWriterMigration.sql.indexOf('create function eng04_preserve_current_geometry('),
)
if (!graphValidation || !graphValidation.includes("count(distinct n->>'agentId')")) throw new Error('Current graph validation contract changed.')
const publication=currentStagedAgentsMigration.sql.match(/create or replace function eng04_check_current_publication\(\)[\s\S]*?end \$\$;/)?.[0]
if(!publication)throw new Error('Current publication validation contract changed.')
export const currentMultiNodeAgentMigration = {version:283802,sql:graphValidation
  .replace('create function eng04_validate_current_graph(', 'create or replace function eng04_validate_current_graph(')
  .replace("    or jsonb_array_length(graph->'nodes')<>(select count(distinct n->>'agentId') from jsonb_array_elements(graph->'nodes') n)\n",'')
  .replace("  if graph ? 'repeat' then perform eng04_validate_repeat_plan(graph); end if;",String.raw`
  for node in select value from jsonb_array_elements(graph->'nodes') loop
    if coalesce(node->>'kind','agent') not in ('agent','job') then raise exception 'CURRENT_EXECUTOR_KIND_INVALID' using errcode='PGC03'; end if;
    if node->>'kind'='job' then
      if node ? 'agentId' or node ? 'initialPrompt' or node ? 'graphqlTools' or graph ? 'handoffs'
        or not exists(select 1 from job_definition_versions j where j.id=node->>'jobDefinitionVersionId'
          and j.definition_id=node->>'jobDefinitionId' and j.workspace_id=graph->>'workspaceId'
          and to_jsonb(j.revision)=node->'jobDefinitionRevision' and j.record->>'versionId'=j.id
          and j.record->>'id'=j.definition_id and j.record->>'workspaceId'=j.workspace_id and j.record->'revision'=node->'jobDefinitionRevision')
        then raise exception 'JOB_VERSION_PIN_CONFLICT' using errcode='PGC03'; end if;
    elsif jsonb_typeof(node->'agentId') is distinct from 'string' then raise exception 'CURRENT_AGENT_ID_INVALID' using errcode='PGC03'; end if;
  end loop;
  if graph ? 'repeat' then perform eng04_validate_repeat_plan(graph); end if;
`)
  + publication.replace("<>jsonb_array_length(graph->'nodes')","<>(select count(distinct n->>'agentId') from jsonb_array_elements(graph->'nodes') n where coalesce(n->>'kind','agent')='agent')")}
