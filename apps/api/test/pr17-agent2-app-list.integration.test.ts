import assert from 'node:assert/strict'

import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@foreman-code/contracts'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import pg from 'pg'
import { describe, it } from 'vitest'

import { PostgresAppInteractionService, decodeInteractionCursor } from '../src/modules/interactions/app.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

function grant(action: 'interactions:read' | 'interactions:respond', workspace: string, workflow: string, run: string) {
  return { actions: [action], scope: { workspaceIds: [workspace], workflowIds: [workflow], runIds: [run] } }
}
function principal(grants: ManagementPrincipal['grants']): ManagementPrincipal {
  return ManagementPrincipalSchema.parse({ id: 'worker', name: 'Worker', audience: 'worker', agentId: 'reviewer', grants,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null })
}
function record(id: string, workspaceId = 'workspace-a', workflowId = 'workflow-a', runId = 'run-a'): DurableInteraction {
  return { ...NATIVE_INTERACTION_FIXTURES.codex, id, workspaceId, workflowId, runId }
}

// An isolated temporary table exercises the actual PostgreSQL authorization and
// pagination query without modifying application data or replacing query semantics.
async function database(work: (service: PostgresAppInteractionService, insert: (...rows: DurableInteraction[]) => Promise<void>) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
  try {
    await pool.query(`create temporary table durable_interactions (
      id text primary key, workspace_id text not null, workflow_id text not null,
      run_id text not null, status text not null, record jsonb not null)`)
    const repository = { get: async (id: string) => (await pool.query<{ record: DurableInteraction }>(
      'select record from durable_interactions where id=$1', [id])).rows[0]?.record } as unknown as PostgresInteractionRepository
    const service = new PostgresAppInteractionService(pool, repository, {} as PostgresCommandCoordinator)
    const insert = async (...rows: DurableInteraction[]) => {
      for (const row of rows) await pool.query(`insert into durable_interactions values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [row.id, row.workspaceId, row.workflowId, row.runId, row.status, JSON.stringify(row)])
    }
    await work(service, insert)
  } finally { await pool.end() }
}

describe('PR17 #17: read grants are applied before PostgreSQL pagination', () => {
  it('fills pages with Run A despite interleaved respond-only Run B rows, without enumerating B', async () => database(async (service, insert) => {
    const worker = principal([grant('interactions:read', 'workspace-a', 'workflow-a', 'run-a'),
      grant('interactions:respond', 'workspace-a', 'workflow-a', 'run-b')])
    await insert(record('01', 'workspace-a', 'workflow-a', 'run-b'), record('02'),
      record('03', 'workspace-a', 'workflow-a', 'run-b'), record('04', 'workspace-a', 'workflow-a', 'run-b'),
      record('05'), record('06', 'workspace-a', 'workflow-a', 'run-b'), record('07'),
      record('08', 'workspace-a', 'workflow-a', 'run-b'))
    const first = await service.list(worker, { limit: 2 })
    assert.deepEqual(first.items.map((item) => item.id), ['02', '05'])
    assert.equal(decodeInteractionCursor(first.nextCursor!), '05')
    const last = await service.list(worker, { limit: 2, cursor: first.nextCursor })
    assert.deepEqual(last.items.map((item) => item.id), ['07'])
    assert.equal(last.nextCursor, null)
    for (const id of ['03', 'not-present']) await assert.rejects(service.get(worker, id), {
      code: 'INTERACTION_NOT_FOUND', status: 404, message: 'The interaction was not found.',
    })
  }), 30_000)

  it('keeps workspace/workflow/run tuples coupled across read grants and deduplicates overlapping grants', async () => database(async (service, insert) => {
    const worker = principal([grant('interactions:read', 'workspace-a', 'workflow-a', 'run-a'),
      grant('interactions:read', 'workspace-b', 'workflow-b', 'run-b'),
      grant('interactions:read', 'workspace-a', 'workflow-a', 'run-a')])
    await insert(record('01', 'workspace-a', 'workflow-b', 'run-b'), record('02'),
      record('03', 'workspace-b', 'workflow-a', 'run-a'), record('04', 'workspace-a', 'workflow-a', 'run-b'),
      record('05', 'workspace-b', 'workflow-b', 'run-b'), record('06', 'workspace-b', 'workflow-b', 'run-a'), record('07'))
    const first = await service.list(worker, { limit: 2 })
    assert.deepEqual(first.items.map((item) => item.id), ['02', '05'])
    assert.equal(decodeInteractionCursor(first.nextCursor!), '05')
    const last = await service.list(worker, { limit: 2, cursor: first.nextCursor })
    assert.deepEqual(last.items.map((item) => item.id), ['07'])
    assert.equal(last.nextCursor, null)
    for (const id of ['01', '03', '04', '06']) await assert.rejects(service.get(worker, id), { status: 404 })
  }), 30_000)

  it('does not expose page presence to a respond-only worker', async () => database(async (service, insert) => {
    const worker = principal([grant('interactions:respond', 'workspace-a', 'workflow-a', 'run-a')])
    await insert(record('01'), record('02'))
    assert.deepEqual(await service.list(worker, { limit: 1 }), { items: [], nextCursor: null })
    await assert.rejects(service.get(worker, '01'), { status: 404 })
  }), 30_000)
})
