import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type pg from 'pg'
import { beforeEach, describe, it, vi } from 'vitest'
import { AgentFileCreateWorkingCopyInputSchema, AgentFilePublishInputSchema, type PermanentFileScope } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FileReferenceRepository } from '../src/modules/files/repository.js'
import type { FileByteStorage } from '../src/modules/files/storage.js'
import { PostgresAgentReferenceAuthorization } from '../src/modules/files/references/agentAuthorization.js'
import { PostgresFileReferenceAuthorization } from '../src/modules/files/references/authorization.js'
import { AgentReferenceService } from '../src/modules/files/references/agentService.js'
import { FileReferenceService } from '../src/modules/files/references/service.js'
import type { AgentReferenceDependencies } from '../src/modules/files/references/agentAccess.js'
import { assertWave25WorkerBinding } from '../src/modules/interactions/wave25/credentialAuthority.js'
import { FILE_REFERENCE_TOOL_NAMES } from '../src/mcp/operator/tools/fileReferences.js'
import { toolRoles } from '../src/mcp/unified/roles.js'

// This suite verifies FIL-37's delegation to existing worker authority, not the engine's native/session fixture.
vi.mock('../src/modules/interactions/wave25/credentialAuthority.js', () => ({ assertWave25WorkerBinding: vi.fn(async () => undefined) }))
const worker: ManagementPrincipal = { id: 'worker', name: 'Worker', audience: 'worker', agentId: 'same-agent',
  expiresAt: '9999-12-31T00:00:00.000Z', revokedAt: null, grants: [{ actions: ['interactions:read'],
    scope: { workspaceIds: ['W'], workflowIds: ['A'], runIds: ['run-A'] } }] }
const human: ManagementPrincipal = { id: 'human', name: 'Human', audience: 'operator', expiresAt: worker.expiresAt,
  revokedAt: null, grants: [{ actions: ['agent_chat:read', 'operator_chat:read'], scope: {} }] }
const origin = { workspace_id: 'W', workflow_id: 'A', agent_id: 'same-agent', run_id: 'run-A', execution_id: 'execution-A' }
const conversation = { id: 'chat-A', kind: 'agent', owner_principal_id: null, workspace_id: 'W', workflow_id: 'A',
  agent_id: 'same-agent', origin_run_id: 'run-A', origin_execution_id: 'execution-A' }

function sqlFixture() {
  const rows = { binding: [origin] as (typeof origin)[], origin: [origin] as (typeof origin)[],
    conversation: { ...conversation } as Omit<typeof conversation, 'owner_principal_id'> & { owner_principal_id: string | null },
    live: { id: human.id, name: human.name, audience: 'operator', grants: human.grants,
      expires_at: new Date(human.expiresAt), revoked_at: null as Date | null, delegated_from: null } }
  const calls: { sql: string; args: unknown[] }[] = []
  const pool = { async query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args })
    if (sql.includes('from worker_credential_bindings')) return { rows: rows.binding, rowCount: rows.binding.length }
    if (sql.includes('from management_principals')) return { rows: [rows.live], rowCount: 1 }
    if (sql.includes('from operator_conversations')) return { rows: [rows.conversation], rowCount: 1 }
    if (sql.includes('from harness_executions')) return { rows: rows.origin, rowCount: rows.origin.length }
    throw new Error(`Unexpected current-graph or unrelated SQL: ${sql}`)
  } } as unknown as pg.Pool
  return { rows, calls, pool, authorization: new PostgresAgentReferenceAuthorization(pool) }
}

describe('FIL-37 strict service inputs and persisted authorization', () => {
  beforeEach(() => vi.mocked(assertWave25WorkerBinding).mockClear())

  it('uses an exact persisted worker binding and preserves the current engine authority check', async () => {
    const f = sqlFixture()
    assert.deepEqual(await f.authorization.resolve(worker, { kind: 'execution' }), {
      workspaceId: 'W', workflowId: 'A', agentId: 'same-agent', runId: 'run-A', executionId: 'execution-A',
    })
    assert.equal(vi.mocked(assertWave25WorkerBinding).mock.calls.length, 1)
    assert.deepEqual(f.calls[0]!.args, ['worker', 'same-agent'])
    assert.match(f.calls[0]!.sql, /e\.id=b\.execution_id and e\.run_id=b\.run_id and e\.agent_id=b\.agent_id/)
    assert.match(f.calls[0]!.sql, /r\.workspace_id=b\.workspace_id and r\.workflow_id=b\.workflow_id/)
  })
  it('denies missing or ambiguous bindings and never infers authority from the shared Agent ID', async () => {
    for (const binding of [[], [origin, origin]]) {
      const f = sqlFixture(); f.rows.binding = binding
      await assert.rejects(f.authorization.resolve(worker, { kind: 'execution' }), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
    }
    assert.equal(vi.mocked(assertWave25WorkerBinding).mock.calls.length, 0)
  })
  it('propagates revoked current-engine authority instead of weakening it for file reads', async () => {
    const f = sqlFixture()
    vi.mocked(assertWave25WorkerBinding).mockRejectedValueOnce(new Error('AUTH_REVOKED'))
    await assert.rejects(f.authorization.resolve(worker, { kind: 'execution' }), /AUTH_REVOKED/)
  })
  it('rejects stale principal claims before database access', async () => {
    const f = sqlFixture()
    for (const principal of [{ ...worker, revokedAt: '2020-01-01T00:00:00.000Z' },
      { ...worker, expiresAt: '2020-01-01T00:00:00.000Z' }]) {
      await assert.rejects(f.authorization.resolve(principal, { kind: 'execution' }), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
    }
    assert.equal(f.calls.length, 0)
  })
  it('uses the exact historical conversation execution; no current workflow or Agent is needed', async () => {
    const f = sqlFixture()
    const result = await f.authorization.resolve(human, { kind: 'conversation', conversationId: 'chat-A' })
    assert.deepEqual(result, { conversationId: 'chat-A', workspaceId: 'W', workflowId: 'A', agentId: 'same-agent',
      runId: 'run-A', executionId: 'execution-A' })
    assert.deepEqual(f.calls.at(-1)!.args, ['execution-A', 'run-A'])
  })
  it('denies a worker another execution\'s conversation, including the same Agent and Run', async () => {
    const f = sqlFixture()
    f.rows.conversation.origin_execution_id = 'execution-other'
    f.rows.origin = [{ ...origin, execution_id: 'execution-other' }]
    await assert.rejects(f.authorization.resolve(worker, { kind: 'conversation', conversationId: 'chat-A' }), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
  })
  it('denies human read grants scoped to another workflow and rechecks the live grants', async () => {
    const f = sqlFixture()
    f.rows.live.grants = [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['W'], workflowIds: ['B'] } }]
    await assert.rejects(f.authorization.resolve(human, { kind: 'conversation', conversationId: 'chat-A' }), { code: 'ACCESS_DENIED' })
  })
  it('returns no inherited scope for an owned global Operator conversation or a global execution view', async () => {
    const f = sqlFixture(); f.rows.conversation.kind = 'operator'; f.rows.conversation.owner_principal_id = human.id
    // Even deliberately Board-looking stored fields cannot turn an Operator conversation into an Agent.
    assert.equal(await f.authorization.resolve(human, { kind: 'conversation', conversationId: 'chat-A' }), null)
    assert.equal(await f.authorization.resolve(human, { kind: 'execution' }), null)
    assert.equal(f.calls.filter((call) => call.sql.includes('from harness_executions')).length, 0)
    await assert.rejects(f.authorization.resolve(worker, { kind: 'conversation', conversationId: 'chat-A' }), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
  })
  it('does not use a foreign-owned global Operator conversation', async () => {
    const f = sqlFixture(); f.rows.conversation.kind = 'operator'; f.rows.conversation.owner_principal_id = 'someone-else'
    await assert.rejects(f.authorization.resolve(human, { kind: 'conversation', conversationId: 'chat-A' }), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
  })
  it('keeps tool arguments limited to pagination and exact pins/ranges; binding exposes no writes', async () => {
    let authorizations = 0
    const service = new AgentReferenceService({ authorization: { resolve: async () => { authorizations++; return null } },
      files: {}, bytes: {}, reads: {} } as unknown as AgentReferenceDependencies)
    const bound = service.forExecution(worker)
    assert.deepEqual(Object.keys(bound).sort(), ['list', 'read'])
    assert.equal(Object.isFrozen(bound), true)
    for (const field of ['scope', 'workspaceId', 'workflowId', 'agentId', 'runId', 'executionId', 'conversationId', 'path']) {
      await assert.rejects(bound.list({ [field]: 'forged' }))
      await assert.rejects(bound.read({ fileId: 'file', revisionId: 'revision', [field]: 'forged' }))
    }
    await assert.rejects(bound.read({ fileId: 'file' }))
    await assert.rejects(bound.read({ fileId: 'file', revisionId: 'revision', length: 65537 }))
    await assert.rejects(bound.list({ limit: 101 }))
    assert.equal(authorizations, 0)
    assert.deepEqual(await bound.list(), { items: [], pageInfo: { nextCursor: null } })
  })
})

describe('FIL-37 does not grant Agents any permanent mutation capability', () => {
  const scopes: PermanentFileScope[] = [
    { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' }, { kind: 'workspace_reference', workspaceId: 'W' },
  ]
  for (const scope of scopes) {
    it(`${scope.kind}: allocate/upload/finalize/cancel/add/remove all reject workers before I/O`, async () => {
      let effects = 0
      const unexpected = async () => { effects++; throw new Error('Unexpected side effect') }
      const pool = { query: unexpected } as unknown as pg.Pool
      const repository = { withAllocation: unexpected, removeReference: unexpected } as unknown as FileReferenceRepository
      const bytes = { receive: unexpected, finalize: unexpected, removeUnsent: unexpected } as unknown as FileByteStorage
      const service = new FileReferenceService(repository, bytes, new PostgresFileReferenceAuthorization(pool), { execute: unexpected })
      // Giving management-looking claims to a worker must not bypass the management audience gate.
      const caller = { ...worker, grants: [{ actions: ['workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update'] as const,
        scope: {} }] } as unknown as ManagementPrincipal
      const upload = { requestId: 'upload-fil37', filename: 'notes.md', mediaType: 'text/markdown', byteSize: 0, sha256: '0'.repeat(64) }
      const stream = Readable.from([Buffer.alloc(0)])
      const operations = [
        () => service.allocate(caller, scope, upload), () => service.upload(caller, scope, upload.requestId, stream),
        () => service.finalize(caller, scope, upload.requestId), () => service.cancel(caller, scope, upload.requestId),
        () => service.add(caller, { scope, upload, contentBase64: '' }),
        () => service.remove(caller, scope, { fileId: 'file', revisionId: 'revision', commandId: 'remove-fil37' }),
      ]
      try { for (const operation of operations) await assert.rejects(operation(), { code: 'ACCESS_DENIED' }) }
      finally { stream.destroy() }
      assert.equal(effects, 0)
    })
  }
  it('keeps permanent replace/publish destinations outside the frozen Agent tools', () => {
    for (const scope of scopes) {
      assert.equal(AgentFilePublishInputSchema.safeParse({ commandId: 'publish-37', artifactId: 'artifact', scope,
        filename: 'notes.md', mediaType: 'text/markdown' }).success, false)
      assert.equal(AgentFileCreateWorkingCopyInputSchema.safeParse({ commandId: 'copy-fil37',
        source: { fileId: 'file', revisionId: 'revision' }, destination: scope }).success, false)
    }
    for (const name of FILE_REFERENCE_TOOL_NAMES) assert.deepEqual(toolRoles(name), ['operator'])
  })
})
