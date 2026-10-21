import { createHash } from 'node:crypto'
import type pg from 'pg'
import { AgentSchema, AgentConfigurationVersionSchema, projectHarnessEffort } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { type CurrentEditSaveInput, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { configurationInput, lockAgentConfigurations, pinnedConfigurationContent } from '../workspaces/agentConfiguration.js'
import { authorizeAgentConfiguration } from '../workspaces/operatorAgents.js'
import { readImmutableAgentConfiguration } from '../workflows/immutableRead.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'

export function authorizeStagedAgents(principal: ManagementPrincipal, input: Pick<CurrentEditSaveInput, 'workspaceId' | 'stagedAgents'>) {
  for (const item of input.stagedAgents ?? []) {
    requireAuthorization(principal, item.baseRevision === null ? 'agents:create' : 'agents:update', { workspaceId: input.workspaceId })
  }
}
/** Read-only planning. Reserved IDs derive from the immutable save command;
 * no Agent/configuration row is inserted until publication admission succeeds. */
export async function prepareCurrentStagedAgents(client: pg.PoolClient, principal: ManagementPrincipal, input: CurrentEditSaveInput,
  accounts?: ProviderAccountConfigurationService) {
  const updates = input.stagedAgents ?? []
  authorizeStagedAgents(principal, input)
  const ids = updates.map((item) => item.agent.id)
  if (new Set(ids).size !== ids.length || ids.some((id) => !input.graph.nodes.some((node) => node.kind !== 'job' && node.agentId === id))) {
    throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'Stage Agent updates must be unique authored graph Agents.', 409)
  }
  await lockAgentConfigurations(client, [...Object.keys(input.expectedAgentConfigurationVersionIds), ...ids])
  const prepared = []
  const resultant = { ...input.expectedAgentConfigurationVersionIds }
  for (const item of updates) {
    const row = (await client.query<{ workspace_id: string; record: unknown; metadata_revision: string; archived_at: Date | null; current_configuration_version_id: string | null }>(
      'select workspace_id,record,metadata_revision::text,archived_at,current_configuration_version_id from agents where id=$1 for share', [item.agent.id])).rows[0]
    const original = input.expectedAgentConfigurationVersionIds[item.agent.id]
    if (item.baseRevision === null ? !!row || !!original || !!item.agent.configurationVersionId
      : !row || row.workspace_id !== input.workspaceId || row.archived_at !== null
        || Number(row.metadata_revision) !== item.baseRevision || row.current_configuration_version_id !== original
        || item.agent.configurationVersionId !== original) {
      throw new DomainError('AGENT_REVISION_CONFLICT', 'The exact displayed Agent metadata/configuration or new Agent identity changed.', 409)
    }
    const references = (await client.query<{ id: string }>(`select id from workflows where workspace_id=$1 and exists(
      select 1 from jsonb_array_elements(record->'nodes') n where n->>'agentId'=$2) order by id`, [input.workspaceId, item.agent.id])).rows
    for (const workflow of references) {
      requireAuthorization(principal, 'graph:read', { workspaceId: input.workspaceId, workflowId: workflow.id })
      requireAuthorization(principal, 'graph:edit', { workspaceId: input.workspaceId, workflowId: workflow.id })
    }
    const old = row ? AgentSchema.parse(row.record) : undefined
    const configRow = original ? (await client.query('select id,workspace_id,agent_id,version,record from agent_configuration_versions where id=$1', [original])).rows[0] : undefined
    const current = configRow ? readImmutableAgentConfiguration(configRow, { id: original!, workspaceId: input.workspaceId, agentId: item.agent.id }) : undefined
    if (row && !current) throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'The original immutable Agent configuration is unavailable.', 409)
    const requested = configurationInput(input.workspaceId, item.agent, current)
    const configInput = { ...requested, harnessProfileSelection: requested.harnessProfileSelection, harness: accounts
      ? await accounts.resolve(requested.harness, requested.harnessProfileSelection, { sql: client }) : requested.harness }
    if (accounts) {
      configInput.harnessProfileSelection = await accounts.profile({ principal, source: 'http',
        configuration: configInput.harness, selection: requested.harnessProfileSelection,
        commandId: input.commandId, client })
    }
    authorizeAgentConfiguration(principal, input.workspaceId, configInput.harness, configInput.assignedSkills)
    const content = await pinnedConfigurationContent(client, input.workspaceId, configInput, current)
    const id = `staged-config-${createHash('sha256').update(`${input.commandId}:${item.agent.id}`).digest('hex')}`
    const now = new Date().toISOString()
    const version = Number((await client.query<{ version: string }>('select coalesce(max(version),0)+1 as version from agent_configuration_versions where agent_id=$1', [item.agent.id])).rows[0]!.version)
    const configuration = AgentConfigurationVersionSchema.parse({ ...content, id, version,
      contentHash: `sha256:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`, createdAt: now })
    const harness = configuration.harness
    const agent = AgentSchema.parse({ ...old, id: item.agent.id, name: item.agent.name, description: item.agent.description,
      role: item.agent.role, productRole: configuration.productRole, harness: harness.harness, harnessConfiguration: harness,
      model: harness.model, effort: projectHarnessEffort(harness), fastMode: harness.harness === 'codex' ? harness.serviceTier === 'priority' : undefined,
      prompt: configuration.prompt, assignedSkills: configuration.assignedSkills, graphqlTools: configuration.graphqlTools, configurationVersionId: id,
      nativeTools: configuration.nativeTools,
      harnessProfileSelection: configuration.harnessProfileSelection,
      createdAt: old?.createdAt ?? now, updatedAt: now })
    resultant[agent.id] = id
    prepared.push({ agent, configuration, baseRevision: item.baseRevision })
  }
  if (input.resultantAgentConfigurationVersionIds && !sameWorkflowValue(resultant, input.resultantAgentConfigurationVersionIds)) {
    throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'The reserved resultant configuration pins changed.', 409)
  }
  return { prepared, resultant }
}

export async function persistCurrentStagedAgents(client: pg.PoolClient, workspaceId: string,
  prepared: Awaited<ReturnType<typeof prepareCurrentStagedAgents>>['prepared']) {
  const result = []
  for (const item of prepared) {
    if (item.baseRevision === null) await client.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [item.agent.id, workspaceId, JSON.stringify({ id: item.agent.id, name: item.agent.name })])
    await client.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,$4,$5::jsonb)',
      [item.configuration.id, workspaceId, item.agent.id, item.configuration.version, JSON.stringify(item.configuration)])
    const row = (await client.query<{ metadata_revision: string }>(`update agents set record=$3::jsonb,current_configuration_version_id=$4,
      metadata_revision=$5 where workspace_id=$1 and id=$2 returning metadata_revision::text`,
    [workspaceId, item.agent.id, JSON.stringify(item.agent), item.configuration.id, (item.baseRevision ?? 0) + 1])).rows[0]!
    result.push({ agent: item.agent, metadataRevision: Number(row.metadata_revision) })
  }
  return result
}
