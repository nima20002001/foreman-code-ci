import assert from 'node:assert/strict'
import type pg from 'pg'
import { describe, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { FileUploadRequestSchema } from '@foreman-code/contracts/files'
import { fileDownloadHeaders } from '../src/routes/files.js'
import { fileFixtures, fileMetadata } from './helpers/fileFixtures.js'

const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: [
    'operator_chat:read', 'operator_chat:write', 'agent_chat:read', 'agent_chat:write',
  ], scope: {} }] }
const operator = { id: 'chat-a', kind: 'operator', owner_principal_id: 'owner', operator_id: 'operator',
  workspace_id: null, workflow_id: null, agent_id: null, origin_run_id: null, origin_execution_id: null }
const agent = { id: 'chat-agent', kind: 'agent', owner_principal_id: null, operator_id: null,
  workspace_id: 'workspace', workflow_id: 'workflow', agent_id: 'agent', origin_run_id: 'run', origin_execution_id: 'execution' }
function authorization(row: typeof operator | typeof agent | undefined) {
  return new PostgresFileConversationAuthorization({ query: async (sql: string, args: unknown[]) => {
    assert.ok(sql.includes('deleted_at is null'))
    return { rows: row && args[0] === row.id && args[1] === row.kind ? [row] : [] }
  } } as unknown as pg.Pool)
}

describe('FIL-03 conversation authority and metadata', () => {
  it('derives the exact Operator scope without navigation/workflow fields', async () => {
    assert.deepEqual(await authorization(operator).resolve(principal, { kind: 'operator', conversationId: 'chat-a' }, 'write'), {
      kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: 'owner', operatorId: 'operator', conversationId: 'chat-a' },
    })
  })
  it('denies foreign Operator ownership even when the caller has all chat actions', async () => {
    await assert.rejects(authorization(operator).resolve({ ...principal, id: 'foreign' }, { kind: 'operator', conversationId: 'chat-a' }, 'read'), { status: 404 })
    await assert.rejects(authorization(undefined).resolve(principal, { kind: 'operator', conversationId: 'missing' }, 'read'), { status: 404 })
  })
  it('binds Agent access to persisted workspace, workflow and Run/execution lineage', async () => {
    const target = { kind: 'agent' as const, conversationId: agent.id, workspaceId: 'workspace' }
    const scoped: ManagementPrincipal = { ...principal, grants: [{ actions: ['agent_chat:read', 'agent_chat:write'],
      scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }] }
    assert.deepEqual(await authorization(agent).resolve(scoped, target, 'write'), { kind: 'temporary', chat: {
      kind: 'agent', conversationId: agent.id, agentId: 'agent', workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', executionId: 'execution',
    } })
    await assert.rejects(authorization(agent).resolve(scoped, { ...target, workspaceId: 'foreign' }, 'read'), { status: 404 })
    const denied = { ...scoped, grants: [{ actions: ['agent_chat:read' as const], scope: { workflowIds: ['other'] } }] }
    await assert.rejects(authorization(agent).resolve(denied, target, 'read'), { status: 403 })
  })
  it('rejects read-only mutation and expired/revoked credentials', async () => {
    const auth = authorization(operator), target = { kind: 'operator' as const, conversationId: 'chat-a' }
    await assert.rejects(auth.resolve({ ...principal, grants: [{ actions: ['operator_chat:read'], scope: {} }] }, target, 'write'), { status: 403 })
    await assert.rejects(auth.resolve({ ...principal, expiresAt: '2000-01-01T00:00:00.000Z' }, target, 'read'), { status: 403 })
    await assert.rejects(auth.resolve({ ...principal, revokedAt: '2020-01-01T00:00:00.000Z' }, target, 'read'), { status: 403 })
  })
  it('composes frozen extension/size/hash rules and rejects extra destination fields', () => {
    for (const fixture of fileFixtures) assert.ok(FileUploadRequestSchema.safeParse({ requestId: 'upload-1', ...fileMetadata(fixture) }).success)
    const value = { requestId: 'upload-1', ...fileMetadata(fileFixtures[0]!) }
    for (const extra of [{ filename: 'bad.exe' }, { filename: '../bad.png' }, { scope: {} }, { workspaceId: 'foreign' }, { byteSize: -1 }, { sha256: 'x' }]) {
      assert.equal(FileUploadRequestSchema.safeParse({ ...value, ...extra }).success, false)
    }
  })
  it('uses attachment-only, no-store, nosniff headers and encodes Unicode without header injection', () => {
    const headers = fileDownloadHeaders('café;"\r\n.md', 'text/markdown', 12)
    assert.equal(headers['content-length'], '12')
    assert.equal(headers['cache-control'], 'private, no-store')
    assert.equal(headers['x-content-type-options'], 'nosniff')
    assert.ok(headers['content-disposition']!.startsWith('attachment;'))
    assert.ok(headers['content-disposition']!.includes('filename*=UTF-8\'\''))
    assert.equal(/[\r\n]/.test(headers['content-disposition']!), false)
  })
})
