import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkerConversationMcpRequestSchema } from './workerConversationMcp.js'

it('keeps the existing delegated credential scoped to an Operator chat without an execution surrogate', () => {
  const binding = { owner: { kind: 'operator', operatorId: 'operator', conversationId: 'chat',
    configurationVersionId: 'configuration', configurationHash: `sha256:${'a'.repeat(64)}` },
    harness: 'codex', appMcpAccess: 'scoped', workingDirectory: '/approved/chat',
    profile: { instanceId: randomUUID(), instanceRevision: 'revision', target: {
      hostRef: { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() }, applicationInstallationId: randomUUID(),
      harnessInstallationId: 'codex-installation', installationFingerprint: 'fingerprint' } } }
  const request = { version: 1, operation: 'conversation-mcp.request', binding, token: 'fixture-delegated-credential',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }
  expect(WorkerConversationMcpRequestSchema.parse(request)).toEqual(request)
  expect(WorkerConversationMcpRequestSchema.safeParse({ ...request, intent: { runId: 'synthetic' } }).success).toBe(false)
  expect(WorkerConversationMcpRequestSchema.safeParse({ ...request, binding: { ...binding, appMcpAccess: 'none' } }).success).toBe(false)
  expect(WorkerConversationMcpRequestSchema.safeParse({ ...request, binding: { ...binding, appMcpAccess: 'none',
    owner: { kind: 'agent', agentId: 'agent', workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node',
      conversationId: 'chat', configurationVersionId: 'configuration', configurationHash: `sha256:${'a'.repeat(64)}` } } }).success).toBe(false)
})


it('carries conversation Agent identity through the scoped paired relay', () => {
  const binding = { owner: { kind: 'agent', agentId: 'agent', workspaceId: 'workspace', workflowId: 'workflow',
    workflowNodeId: 'node', conversationId: 'chat', configurationVersionId: 'configuration',
    configurationHash: `sha256:${'a'.repeat(64)}` }, harness: 'codex', appMcpAccess: 'scoped', workingDirectory: '/project',
    profile: { instanceId: randomUUID(), instanceRevision: 'revision', target: {
      hostRef: { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() }, applicationInstallationId: randomUUID(),
      harnessInstallationId: 'codex-installation', installationFingerprint: 'fingerprint' } } }
  const request = { version: 1, operation: 'conversation-mcp.authorize', binding,
    admissionId: randomUUID(), token: 'conversation-token' }
  expect(WorkerConversationMcpRequestSchema.parse(request)).toEqual(request)
  expect(WorkerConversationMcpRequestSchema.safeParse({ ...request, admissionId: undefined }).success).toBe(false)
})
