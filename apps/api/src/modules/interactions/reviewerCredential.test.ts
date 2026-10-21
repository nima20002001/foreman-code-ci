import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { requireReviewerCredential } from './reviewerCredential.js'

const scope = { agentId: 'reviewer', workspaceId: 'workspace', workflowId: 'workflow', runId: 'run' }
function fixture() {
  const row = {
    id: 'principal', name: 'Reviewer', audience: 'worker', agent_id: scope.agentId,
    expires_at: new Date(Date.now() + 60_000), revoked_at: null as Date | null,
    grants: [{ actions: ['interactions:read', 'interactions:respond'],
      scope: { workspaceIds: [scope.workspaceId], workflowIds: [scope.workflowId], runIds: [scope.runId] } }],
  }
  const sql = { query: async () => ({ rows: [row], rowCount: 1 }) } as unknown as GraphSqlClient
  return { row, sql }
}

describe('reviewer process credentials', () => {
  it('accepts the original Worker with both explicitly scoped App actions', async () => {
    const f = fixture()
    await expect(requireReviewerCredential(f.sql, f.row.id, scope)).resolves.toBeUndefined()
  })
  it.each(['operator', 'agent', 'expiry', 'revoked'] as const)('denies a changed %s', async field => {
    const f = fixture()
    if (field === 'operator') f.row.audience = 'operator'
    if (field === 'agent') f.row.agent_id = 'requester'
    if (field === 'expiry') f.row.expires_at = new Date(0)
    if (field === 'revoked') f.row.revoked_at = new Date()
    await expect(requireReviewerCredential(f.sql, f.row.id, scope))
      .rejects.toMatchObject({ code: 'REVIEWER_CREDENTIAL_LOST' })
  })
  it.each(['workspaceIds', 'workflowIds', 'runIds'] as const)('requires the %s in the same action grant', async field => {
    const f = fixture()
    f.row.grants[0]!.scope[field] = ['other']
    await expect(requireReviewerCredential(f.sql, f.row.id, scope))
      .rejects.toMatchObject({ code: 'REVIEWER_CREDENTIAL_LOST' })
  })
  it('denies a reader and does not combine partial grants into review permission', async () => {
    const f = fixture()
    f.row.grants[0]!.actions = ['interactions:read']
    await expect(requireReviewerCredential(f.sql, f.row.id, scope))
      .rejects.toMatchObject({ code: 'REVIEWER_CREDENTIAL_LOST' })
    f.row.grants.push(
      { actions: ['interactions:respond'], scope: { workspaceIds: ['workspace'], workflowIds: ['other'], runIds: ['run'] } },
      { actions: ['interactions:respond'], scope: { workspaceIds: ['other'], workflowIds: ['workflow'], runIds: ['run'] } },
    )
    await expect(requireReviewerCredential(f.sql, f.row.id, scope))
      .rejects.toMatchObject({ code: 'REVIEWER_CREDENTIAL_LOST' })
  })
  it('denies a missing principal', async () => {
    const sql = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool
    await expect(requireReviewerCredential(sql, 'missing', scope))
      .rejects.toMatchObject({ code: 'REVIEWER_CREDENTIAL_LOST' })
  })
})
