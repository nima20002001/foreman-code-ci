import { describe, expect, it, vi } from 'vitest'
import type { AuthorizedFileCaller } from '../files/tools/types.js'
import type { AcceptedArtifactPublication } from '../files/distributed/publication.js'
import type { FileQuery } from '../files/repository.js'
import type { WorkerMcpRelayRequest } from '@foreman-code/contracts/worker-mcp-relay'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { createWorkerNativeOutputAuthorizationPort } from './workerMcpRelay.js'

// SQL authority and context-resolution boundaries are doubles. This tests the
// additional operation policy; it does not qualify a native host or grant access.
function fixture() {
  const request = { intent: { executionId: 'execution', runId: 'run', nodeId: 'node', attemptId: 'attempt', bindingHash: 'a'.repeat(64) },
    applicationAccess: { agentId: 'agent' }, outputOperation: 'create', nativeSessionId: 'native', turnId: 'turn' } as Extract<WorkerMcpRelayRequest, { operation: 'worker-mcp.authorize-native-output' }>
  const context: AuthorizedFileCaller['context'] = { ownerPrincipalId: 'owner', nativeSessionId: 'native', turnId: 'turn',
    allowMutation: true, allowedTools: ['files.write_working_copy', 'files.publish_result'],
    scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation', workspaceId: 'workspace', workflowId: 'workflow',
      agentId: 'agent', runId: 'run', executionId: 'execution' } } }
  const accepted = { context, attempt: { workspaceId: 'workspace', workflowId: 'workflow', executionId: 'execution', runId: 'run', nodeId: 'node', attemptId: 'attempt', placementHash: 'a'.repeat(64) } } as AcceptedArtifactPublication
  const caller: AuthorizedFileCaller = { context, binding: 'binding', principal: { id: 'owner', name: 'Owner', audience: 'operator',
    expiresAt: new Date(Date.now() + 60000).toISOString(), revokedAt: null,
    grants: [{ actions: ['agent_chat:write'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }] } }
  const authorize = vi.fn(async () => caller), resolve = vi.fn(async () => accepted)
  const assertNativeOutputConnection = vi.fn(async () => {})
  const authorizeNativeOutputDeclarations = vi.fn(async () => ({ agentConfigurationVersionId: 'configuration', outputOperations: ['create', 'append', 'seal', 'publish'] as ['create', 'append', 'seal', 'publish'] }))
  const port = createWorkerNativeOutputAuthorizationPort({ authorize, assertNativeOutputConnection, authorizeNativeOutputDeclarations }, resolve)
  const sql = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as FileQuery, connection = {} as DeviceConnectionIdentity
  return { request, accepted, caller, authorize, assertNativeOutputConnection, authorizeNativeOutputDeclarations, resolve, port, sql, connection }
}
describe('native output existing publication authority plus operation policy', () => {
  it.each(['create', 'append', 'seal', 'publish'] as const)('checks %s on the original SQL connection', async outputOperation => {
    const f = fixture(); f.request.outputOperation = outputOperation
    expect(await f.port.authorize(f.request, f.connection, f.sql)).toEqual(f.caller.context.scope)
    expect(f.assertNativeOutputConnection).toHaveBeenCalledWith(f.request, f.connection, f.sql)
    expect(f.sql.query).toHaveBeenCalledWith(expect.stringContaining('insert into management_audit'), expect.arrayContaining([`native_output.authorize.${outputOperation}`]))
    expect(f.resolve).toHaveBeenCalledWith(f.request, f.connection, f.sql)
    expect(f.authorize).toHaveBeenCalledWith(f.accepted, f.sql)
  })
  it.each(['readonly', 'missing-tool', 'foreign-session', 'foreign-turn', 'foreign-attempt', 'foreign-workspace', 'foreign-workflow', 'read-grant', 'revoked', 'expired'] as const)('denies %s', async reason => {
    const f = fixture()
    if (reason === 'readonly') f.caller.context.allowMutation = false
    if (reason === 'missing-tool') f.caller.context.allowedTools = ['files.publish_result']
    if (reason === 'foreign-session') f.caller.context.nativeSessionId = 'foreign'
    if (reason === 'foreign-turn') f.caller.context.turnId = 'foreign'
    if (reason === 'foreign-attempt') f.accepted.attempt.attemptId = 'foreign'
    if (reason === 'foreign-workspace') f.accepted.attempt.workspaceId = 'foreign'
    if (reason === 'foreign-workflow') f.accepted.attempt.workflowId = 'foreign'
    if (reason === 'read-grant') f.caller.principal.grants[0]!.actions = ['agent_chat:read']
    if (reason === 'revoked') f.caller.principal.revokedAt = new Date().toISOString()
    if (reason === 'expired') f.caller.principal.expiresAt = new Date(0).toISOString()
    await expect(f.port.authorize(f.request, f.connection, f.sql)).rejects.toMatchObject({ status: 403 })
  })
  it('requires publication allowlist separately from write permission and propagates original authority withdrawal', async () => {
    const f = fixture(); f.request.outputOperation = 'publish'; f.caller.context.allowedTools = ['files.write_working_copy']
    await expect(f.port.authorize(f.request, f.connection, f.sql)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_DENIED' })
    f.authorize.mockRejectedValueOnce(new Error('original authority withdrawn'))
    await expect(f.port.authorize(f.request, f.connection, f.sql)).rejects.toThrow('original authority withdrawn')
  })
})
