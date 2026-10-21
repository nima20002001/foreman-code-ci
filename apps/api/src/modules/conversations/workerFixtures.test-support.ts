import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { AgentConfigurationVersionSchema, OperatorConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS,
  type AgentHarness } from '@foreman-code/contracts'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'

/** Protocol data only; it contains no installed/native qualification. */
export function workerConversationFixture(kind: 'operator' | 'agent' = 'operator', harness: AgentHarness = 'codex') {
  const deviceConnection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const connection = { ...deviceConnection, connectionEpoch: randomUUID() }
  const profile = { instanceId: randomUUID(), instanceRevision: 'profile-fixture', target: {
    hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
    applicationInstallationId: connection.workerInstallationId,
    harnessInstallationId: 'driver-fixture', installationFingerprint: 'installation-fixture',
  } }
  const settings = harness === 'claude' ? {
    harness, model: 'model-fixture', authMode: 'subscription', configDirectory: '/uncreated/profile-fixture',
    permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {},
  } : DEFAULT_HARNESS_DEFAULTS[harness]
  const common = { id: randomUUID(), version: 1, harness: settings, harnessProfileSelection: profile,
    contentHash: `sha256:${'a'.repeat(64)}`, createdAt: '2026-10-05T00:00:00.000Z' }
  const configuration = kind === 'operator'
    ? OperatorConfigurationVersionSchema.parse({ ...common, operatorId: 'application-operator' })
    : AgentConfigurationVersionSchema.parse({ ...common, workspaceId: 'workspace', agentId: 'agent',
      prompt: {}, assignedSkills: [] })
  const owner = 'operatorId' in configuration
    ? { kind: 'operator', operatorId: configuration.operatorId }
    : { kind: 'agent', workspaceId: configuration.workspaceId, workflowId: 'workflow',
      workflowNodeId: 'node', agentId: configuration.agentId }
  const binding = WorkerConversationBindingSchema.parse({
    owner: { ...owner, conversationId: randomUUID(), configurationVersionId: configuration.id,
      configurationHash: commandInputHash(configuration) },
    harness, profile, workingDirectory: '/approved/project-fixture', appMcpAccess: 'none',
  })
  const session = { harness, providerVersion: 'provider-fixture', nativeSessionId: randomUUID() }
  const nativeOwner = { sessionId: session.nativeSessionId, processIdentityDigest: 'b'.repeat(64) }
  return { binding, configuration, connection, deviceConnection, session, nativeOwner }
}
