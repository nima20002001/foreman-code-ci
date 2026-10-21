import { createHash, randomUUID } from 'node:crypto'

import {
  AgentConfigurationVersionSchema,
  AgentSchema,
  RETIRED_OPENCODE_MESSAGE,
  projectHarnessEffort,
  type Agent,
  type AgentConfigurationVersion,
  graphqlToolsOutsideRole,
  newAgentGraphqlTools,
} from '@foreman-code/contracts'
import type pg from 'pg'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { HarnessConfiguration } from '@foreman-code/contracts'

import { DomainError } from '../errors.js'
import { assertClaudeFullAccess } from '../harnesses/nativeWorkflowConfiguration.js'
import { resolveAssignedSkills } from '../skills/catalog.js'
import { composeInstructionText, instructionsTooLarge } from '../skills/instructions.js'

export function configurationInput(
  workspaceId: string,
  agent: Agent,
  current?: AgentConfigurationVersion,
  creation = false,
) {
  if (agent.harness && agent.harnessConfiguration
    && agent.harness !== agent.harnessConfiguration.harness) {
    throw new DomainError('AGENT_HARNESS_MISMATCH', 'The agent harness and its configuration must match.', 400)
  }
  const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? current?.harness.harness ?? 'codex'
  if (harness === 'opencode') {
    throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
  }
  const prompt = agent.prompt ?? current?.prompt ?? {}
  const assignedSkills = agent.assignedSkills ?? current?.assignedSkills ?? []
  const productRole = agent.productRole ?? current?.productRole
  const graphqlTools = agent.graphqlTools ?? current?.graphqlTools
    ?? (creation && productRole ? newAgentGraphqlTools(productRole) : undefined)
  const nativeTools = Object.hasOwn(agent, 'nativeTools') ? agent.nativeTools : current?.nativeTools
  const nativePolicy = nativeTools ? { nativeTools } : {}
  const harnessProfileSelection = Object.hasOwn(agent, 'harnessProfileSelection') ? agent.harnessProfileSelection : current?.harnessProfileSelection
  const profile = harnessProfileSelection ? { harnessProfileSelection } : {}
  const outside = graphqlToolsOutsideRole(productRole ?? 'coder', graphqlTools ?? [])
  if (outside.length) {
    throw new DomainError('GRAPHQL_TOOL_NOT_ALLOWED_FOR_ROLE',
      `The ${productRole === 'master' ? 'Master' : productRole === 'orchestrator' ? 'Orchestrator' : 'Worker'} role cannot use ${outside.join(', ')}.`, 400, { tools: outside })
  }
  if (harness === 'claude') {
    const configuration = agent.harnessConfiguration?.harness === 'claude' ? agent.harnessConfiguration
      : current?.harness.harness === 'claude' ? current.harness : undefined
    if (!configuration) throw new DomainError('AGENT_CONFIGURATION_REQUIRED', 'Claude requires an explicit accepted configuration.', 400)
    return { workspaceId, agentId: agent.id, productRole, prompt, assignedSkills, ...profile, ...nativePolicy,
      ...(graphqlTools ? { graphqlTools } : {}), harness: configuration } as const
  }
  const suppliedHarness = agent.harnessConfiguration?.harness === 'codex'
    ? agent.harnessConfiguration
    : undefined
  const currentHarness = suppliedHarness
    ?? (current?.harness.harness === 'codex' ? current.harness : undefined)
  return {
    workspaceId,
    ...profile,
    ...nativePolicy,
    agentId: agent.id,
    productRole,
    prompt,
    assignedSkills,
    ...(graphqlTools ? { graphqlTools } : {}),
    harness: {
      harness,
      model: agent.model ?? currentHarness?.model ?? 'gpt-5.6-luna',
      reasoningEffort: agent.effort ?? currentHarness?.reasoningEffort ?? 'medium',
      sandbox: currentHarness?.sandbox ?? 'read-only',
      serviceTier: (agent.fastMode ?? (currentHarness?.serviceTier === 'priority')) ? 'priority' : 'standard',
      ...(currentHarness?.accountId ? { accountId: currentHarness.accountId } : {}),
      ...(currentHarness?.advanced ? { advanced: currentHarness.advanced } : {}),
    },
  } as const
}

/** Pins exact server-resolved skill snapshots and native instruction delivery into new
 * configuration content. Callers cannot supply resolvedSkills; only references are accepted. */
export async function pinnedConfigurationContent<T extends Pick<AgentConfigurationVersion, 'prompt' | 'assignedSkills'>>(
  client: pg.ClientBase, workspaceId: string, input: T, current?: AgentConfigurationVersion,
) {
  const resolvedSkills = await resolveAssignedSkills(client, workspaceId, input.assignedSkills, current?.assignedSkills)
  const content = { ...input, ...(resolvedSkills.length ? { resolvedSkills } : {}), instructionDelivery: 'native-v1' as const }
  if (instructionsTooLarge(composeInstructionText(content))) {
    throw new DomainError('AGENT_INSTRUCTIONS_TOO_LARGE', 'Agent instructions and assigned skills exceed the 512 KiB limit. Remove skills or shorten the instructions.', 400)
  }
  return content
}

/** Lock every referenced agent in the same order before taking row locks. */
export async function lockAgentConfigurations(client: pg.PoolClient, agentIds: readonly string[]): Promise<void> {
  for (const agentId of [...new Set(agentIds)].sort()) {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent:${agentId}`])
  }
}

/** Used by both board and standalone saves, inside the caller's transaction. */
export async function saveAgentConfiguration(
  client: pg.PoolClient,
  workspaceId: string,
  input: Agent,
  mustExist = false,
  validateProfileSelection?: (selection: HarnessProfileSelection, configuration: HarnessConfiguration, client: pg.PoolClient) => Promise<void>,
): Promise<Agent> {
  const parsed = AgentSchema.parse(input)
  await lockAgentConfigurations(client, [parsed.id])
  const existingRow = await client.query<{
    workspace_id: string
    archived_at: Date | null
    current_configuration_version_id: string | null
    record: unknown
  }>('select workspace_id, archived_at, current_configuration_version_id, record from agents where id = $1 for update', [parsed.id])
  const existing = existingRow.rows[0]
  if (existing?.archived_at) throw new DomainError('AGENT_ARCHIVED', 'Restore the archived Agent before editing it.', 409)
  if (!existing && mustExist) {
    throw new DomainError('AGENT_NOT_FOUND', `Agent '${parsed.id}' was not found.`, 404)
  }
  if (existing && existing.workspace_id !== workspaceId) {
    throw new DomainError('AGENT_WORKSPACE_MISMATCH', `Agent '${parsed.id}' belongs to another workspace.`, 409)
  }
  // Check before hashing or writing, including apparently unchanged snapshots.
  if (parsed.configurationVersionId !== (existing?.current_configuration_version_id ?? undefined)) {
    throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'These agent settings are out of date. Reload the agent before saving.', 409)
  }

  const currentConfiguration = existing?.current_configuration_version_id
    ? await client.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id = $1 and workspace_id = $2 and agent_id = $3',
        [existing.current_configuration_version_id, workspaceId, parsed.id],
      )
    : undefined
  const current = currentConfiguration?.rows[0]
    ? AgentConfigurationVersionSchema.parse(currentConfiguration.rows[0].record)
    : undefined
  if (!current && (mustExist || existing?.current_configuration_version_id)) {
    throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'This agent has no persisted configuration to edit.', 409)
  }
  const nextConfiguration = configurationInput(workspaceId, parsed, current, !existing)
  assertClaudeFullAccess(nextConfiguration.harness)
  if (nextConfiguration.harnessProfileSelection) {
    if (!validateProfileSelection) throw new DomainError('HARNESS_PROFILE_SELECTION_UNAVAILABLE', 'Selected host profile validation is not composed.', 503)
    await validateProfileSelection(nextConfiguration.harnessProfileSelection, nextConfiguration.harness, client)
  }
  const nextInput = await pinnedConfigurationContent(client, workspaceId, nextConfiguration, current)
  const nextHash = `sha256:${createHash('sha256').update(JSON.stringify(nextInput)).digest('hex')}`
  const now = new Date().toISOString()

  if (!existing) {
    const placeholder = AgentSchema.parse({ id: parsed.id, name: parsed.name, role: parsed.role, productRole: parsed.productRole })
    await client.query(
      `insert into agents (id, workspace_id, current_configuration_version_id, record)
       values ($1, $2, null, $3::jsonb)`,
      [parsed.id, workspaceId, JSON.stringify(placeholder)],
    )
  }

  let configuration = current
  if (!configuration || configuration.contentHash !== nextHash) {
    const versionResult = await client.query<{ next_version: number }>(
      'select coalesce(max(version), 0) + 1 as next_version from agent_configuration_versions where agent_id = $1',
      [parsed.id],
    )
    const version = Number(versionResult.rows[0]?.next_version ?? 1)
    configuration = AgentConfigurationVersionSchema.parse({
      ...nextInput,
      id: `${parsed.id}-config-v${version}-${randomUUID()}`,
      version,
      contentHash: nextHash,
      createdAt: now,
    })
    await client.query(
      `insert into agent_configuration_versions (id, workspace_id, agent_id, version, record)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [configuration.id, workspaceId, parsed.id, version, JSON.stringify(configuration)],
    )
  }

  const previousAgent = existing ? AgentSchema.parse(existing.record) : undefined
  const harness = configuration.harness
  // Operational state remains server-owned on both save paths.
  const agent = AgentSchema.parse({
    ...previousAgent,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    role: parsed.role,
    productRole: configuration.productRole,
    harness: harness.harness,
    model: harness.model,
    effort: projectHarnessEffort(harness),
    fastMode: harness.harness === 'codex' ? harness.serviceTier === 'priority' : undefined,
    harnessConfiguration: harness,
    harnessProfileSelection: configuration.harnessProfileSelection,
    configurationVersionId: configuration.id,
    prompt: configuration.prompt,
    assignedSkills: configuration.assignedSkills,
    graphqlTools: configuration.graphqlTools,
    nativeTools: configuration.nativeTools,
    createdAt: previousAgent?.createdAt ?? parsed.createdAt ?? now,
    updatedAt: now,
  })
  await client.query(
    `update agents
     set current_configuration_version_id = $2, record = $3::jsonb
     where id = $1 and workspace_id = $4`,
    [agent.id, configuration.id, JSON.stringify(agent), workspaceId],
  )
  return agent
}
