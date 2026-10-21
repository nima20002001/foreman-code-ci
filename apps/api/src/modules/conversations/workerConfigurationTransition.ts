import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationBinding, WorkerConversationConfiguration }
  from '@foreman-code/contracts/remote-execution-rpc'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { definedProperties } from '../definedProperties.js'
import { validRunChatSkillsTransition } from './workerRunChatBinding.js'
import { harnessSessionChanged } from '../harnesses/providerAccountConfiguration.js'
import { verifiedSkills } from '../skills/instructions.js'

/** Run lineage and the working folder outlive changes to the selected native session. */
function validAgentConfigurationChange(previous: WorkerConversationBinding, next: WorkerConversationBinding,
  base: WorkerConversationConfiguration, configuration: WorkerConversationConfiguration): boolean {
  if (previous.owner.kind !== 'agent' || next.owner.kind !== 'agent'
    || !('agentId' in base) || !('agentId' in configuration)
    || base.id !== previous.owner.configurationVersionId || configuration.id !== next.owner.configurationVersionId
    || base.id === configuration.id || base.agentId !== previous.owner.agentId
    || base.workspaceId !== previous.owner.workspaceId || configuration.agentId !== base.agentId
    || configuration.workspaceId !== base.workspaceId
    || commandInputHash(base) !== previous.owner.configurationHash
    || commandInputHash(configuration) !== next.owner.configurationHash
    || base.harness.harness !== previous.harness || configuration.harness.harness !== next.harness
    || !isDeepStrictEqual(previous.profile.target.hostRef, next.profile.target.hostRef)
    || previous.profile.target.applicationInstallationId !== next.profile.target.applicationInstallationId
    || !isDeepStrictEqual(configuration.harnessProfileSelection, next.profile)) return false
  const owner = { ...previous.owner, configurationVersionId: next.owner.configurationVersionId,
    configurationHash: next.owner.configurationHash }
  const directory = previous.directoryBinding
  const directoryBinding = directory ? { ...directory, placement: { ...directory.placement,
    instanceId: next.profile.instanceId, instanceRevision: next.profile.instanceRevision,
    harnessInstallationId: next.profile.target.harnessInstallationId } } : undefined
  const sourceConfigurationVersionId = previous.sourceExecution
    ? previous.sourceConfigurationVersionId ?? previous.owner.configurationVersionId : undefined
  verifiedSkills(base)
  verifiedSkills(configuration)
  return isDeepStrictEqual(definedProperties({ ...previous, owner, profile: next.profile,
    harness: next.harness, accountBinding: next.accountBinding,
    directoryBinding, sourceConfigurationVersionId }), next)
}

export function validAgentSessionReplacement(previous: WorkerConversationBinding, next: WorkerConversationBinding,
  base: WorkerConversationConfiguration, configuration: WorkerConversationConfiguration): boolean {
  return validAgentConfigurationChange(previous, next, base, configuration)
}

export function validAgentConfigurationTransition(previous: WorkerConversationBinding, next: WorkerConversationBinding,
  base: WorkerConversationConfiguration, configuration: WorkerConversationConfiguration): boolean {
  return base.harness.harness !== 'opencode' && configuration.harness.harness !== 'opencode'
    && base.harness.harness === configuration.harness.harness
    && !harnessSessionChanged(base.harness, configuration.harness)
    && !(base.harness.harness === 'claude' && configuration.harness.harness === 'claude'
      && base.harness.configDirectory !== configuration.harness.configDirectory)
    && base.harness.accountId === configuration.harness.accountId
    && previous.profile.instanceId === next.profile.instanceId
    && isDeepStrictEqual(previous.profile.target, next.profile.target)
    && isDeepStrictEqual(previous.accountBinding, next.accountBinding)
    && validAgentConfigurationChange(previous, next, base, configuration)
}

export function validWorkerConfigurationTransition(previous: WorkerConversationBinding, next: WorkerConversationBinding,
  base: WorkerConversationConfiguration, configuration: WorkerConversationConfiguration): boolean {
  return validRunChatSkillsTransition(previous, next, base, configuration)
    || validAgentConfigurationTransition(previous, next, base, configuration)
}

export async function readAgentConfigurationTransition(pool: pg.Pool, previous: WorkerConversationBinding,
  next: WorkerConversationBinding, configuration: WorkerConversationConfiguration) {
  if (previous.owner.kind !== 'agent' || next.owner.kind !== 'agent'
    || previous.owner.configurationVersionId === next.owner.configurationVersionId) return undefined
  const nodeId = previous.owner.workflowNodeId
  const row = (await pool.query<{ record: unknown }>(
    'select record from agent_configuration_versions where id=$1', [previous.owner.configurationVersionId])).rows[0]
  if (!row) return undefined
  let base = AgentConfigurationVersionSchema.parse(row.record)
  if (commandInputHash(base) !== previous.owner.configurationHash && previous.sourceExecution) {
    const saved = (await pool.query<{ record: unknown }>(`select v.record from workflow_versions v
      join runs r on r.workflow_version_id=v.id where r.id=$1 and r.workspace_id=$2`,
    [previous.sourceExecution.placement.runId, base.workspaceId])).rows[0]
    const version = WorkflowVersionV3Schema.parse(saved?.record)
    const node = version.definition.nodes.find(item => item.id === nodeId)
    if (node && node.kind !== 'job' && node.agentId === base.agentId && node.skills) {
      base = configurationWithNodeSkills(base, node.skills, version.nodeSkillSnapshots?.[node.id])
    }
  }
  return validAgentSessionReplacement(previous, next, base, configuration) ? base : undefined
}
