import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryExecution } from '../../../test/helpers/eng06Recovery.testSupport.js'
import type { PostgresAccessService } from '../access/postgres.js'
import { readRecoverableRemoteReviewer } from './retainedRemoteReviewer.js'
import { assertWave25WorkerBinding } from './wave25/credentialAuthority.js'
import { Wave25WorkerCredentialService } from './wave25/credentials.js'

vi.mock('./retainedRemoteReviewer.js', () => ({
  readRecoverableRemoteReviewer: vi.fn(), readRetainedRemoteReviewer: vi.fn(async () => undefined),
}))
beforeEach(() => vi.clearAllMocks())

function fixture() {
  const execution = recoveryExecution('completed')
  const principalId = 'original-principal'
  const binding = { execution_id: execution.id, run_id: execution.runId, purpose: 'reviewer',
    workspace_id: 'workspace', workflow_id: 'workflow', agent_id: execution.agentId,
    approval_review_job_id: 'review', approval_review_lease_fence: '1',
    approval_native_session_id: execution.nativeSessionId, approval_connection_generation: '1',
    live: true, environment_variable: 'GRAPHQL_MCP_TOKEN', execution_semantics_version: 3 }
  const revoked = { principal: false, binding: false }
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const client = { release() {}, async query(statement: string) {
    const text = statement.replace(/\s+/g, ' ').trim()
    if (text.startsWith('select b.principal_id,b.execution_id')) {
      return result([{ principal_id: principalId, execution_id: execution.id }])
    }
    if (text.startsWith('select run_id from harness_executions')) return result([{ run_id: execution.runId }])
    if (text.startsWith('select b.*')) return result([binding])
    if (text.startsWith('select 1 from review_jobs')) return result([])
    if (text.startsWith('select record from harness_executions')) return result([{ record: execution }])
    if (text.startsWith('select b.execution_id,b.principal_id')) return result([])
    if (text.startsWith('update management_principals set revoked_at')) revoked.principal = true
    if (text.startsWith('update worker_credential_bindings set revoked_at')) revoked.binding = true
    if (text.startsWith('update') || text.startsWith('select id') || text.startsWith('select principal_id')
      || ['begin', 'commit', 'rollback'].includes(text)) return result([])
    throw new Error('Unexpected reviewer credential query')
  } }
  const pool = { query: client.query, connect: async () => client } as unknown as pg.Pool
  const service = new Wave25WorkerCredentialService(pool, {} as PostgresAccessService)
  return { execution, principalId, revoked, pool, service }
}

describe('reviewer credentials pending authenticated recovery', () => {
  it.each([false, true])('preserves a recovery candidate with detached=%s while denying its stale App binding', async detached => {
    const f = fixture()
    vi.mocked(readRecoverableRemoteReviewer).mockResolvedValue({ generation: '1', principalId: f.principalId,
      session: { harness: 'codex', providerVersion: '1.0.0', nativeSessionId: f.execution.nativeSessionId! }, detached })
    await f.service.reconcileTerminalCredentials()
    expect(f.revoked).toEqual({ principal: false, binding: false })
    await expect(assertWave25WorkerBinding(f.pool, f.principalId))
      .rejects.toMatchObject({ code: 'REVIEWER_BINDING_REBIND_REQUIRED' })
  })

  it.each(['missing', 'different-principal'] as const)('revokes a stale binding with a %s recovery candidate', async candidate => {
    const f = fixture()
    vi.mocked(readRecoverableRemoteReviewer).mockResolvedValue(candidate === 'missing' ? undefined : {
      generation: '1', principalId: 'replacement-principal',
      session: { harness: 'codex', providerVersion: '1.0.0', nativeSessionId: f.execution.nativeSessionId! }, detached: false,
    })
    await expect(assertWave25WorkerBinding(f.pool, f.principalId)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await f.service.reconcileTerminalCredentials()
    expect(f.revoked).toEqual({ principal: true, binding: true })
  })
})
