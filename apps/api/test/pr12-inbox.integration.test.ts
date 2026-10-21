import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@foreman-code/contracts'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'

// Uses only a connection-local temporary table. No persistent schema or production record is changed.
const enabled = Boolean(process.env.TEST_DATABASE_URL)
describe.skipIf(!enabled)('PR12 authorized Inbox pagination in PostgreSQL', () => {
  let client: pg.Client
  let repository: PostgresInteractionRepository
  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    await client.query('create temporary table durable_interactions (id text primary key, workspace_id text, workflow_id text, run_id text, status text, record jsonb)')
    repository = new PostgresInteractionRepository({ query: client.query.bind(client) } as unknown as pg.Pool)
    const add = async (id: string, workspaceId: string, workflowId: string, handler: 'user' | 'orchestrator', runId = id) => {
      const record: DurableInteraction = { ...NATIVE_INTERACTION_FIXTURES.codex, id, workspaceId, workflowId, runId,
        approval: handler === 'orchestrator' ? { handler, designatedOrchestratorAgentId: 'reviewer' } : { handler } }
      await client.query('insert into durable_interactions values ($1,$2,$3,$4,$5,$6::jsonb)', [id, workspaceId, workflowId, runId, 'pending', JSON.stringify(record)])
    }
    for (let i = 0; i < 105; ++i) await add(`a-${String(i).padStart(3, '0')}`, 'other', 'other-flow', 'user')
    await add('z-001', 'target', 'target-flow', 'user', 'allowed-run')
    await add('z-002', 'target', 'target-flow', 'orchestrator')
  })
  afterAll(async () => { if (client) await client.end() })
  it('filters workspace authorization before LIMIT and counts every permitted pending request', async () => {
    const scopes = [{ workspaceIds: ['target'] }]
    const first = await repository.list({ scopes, limit: 1 })
    expect(first.map((item) => item.id)).toEqual(['z-001'])
    expect(await repository.pendingCounts({ scopes })).toEqual({ pendingCount: 2, pendingByWorkflow: { 'target-flow': 2 } })
    const next = await repository.list({ scopes, afterId: first[0]!.id, limit: 1 })
    expect(next.map((item) => item.id)).toEqual(['z-002'])
  })
  it('intersects all dimensions within a grant and unions distinct grants', async () => {
    expect(await repository.list({ scopes: [{ workspaceIds: ['target'], workflowIds: ['other-flow'] }], limit: 100 })).toEqual([])
    expect((await repository.list({ scopes: [{ runIds: ['allowed-run'] }], limit: 100 })).map((item) => item.id)).toEqual(['z-001'])
    expect((await repository.pendingCounts({ scopes: [{ workspaceIds: ['other'] }, { runIds: ['allowed-run'] }] })).pendingCount).toBe(106)
  })
  it('keeps handler filtering distinct from read-only monitoring', async () => {
    const scope = { workspaceId: 'target', scopes: [{ workspaceIds: ['target'] }] }
    expect((await repository.list({ ...scope, handler: 'user', limit: 100 })).map((item) => item.id)).toEqual(['z-001'])
    expect((await repository.list({ ...scope, limit: 100 })).map((item) => item.approval.handler)).toEqual(['user', 'orchestrator'])
    expect(await repository.list({ scopes: [], limit: 100 })).toEqual([])
    expect((await repository.pendingCounts({ scopes: [] })).pendingCount).toBe(0)
  })
})
