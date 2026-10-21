import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture, CurrentWorkflowSaveResultSchema, RunStartV3InputSchema, WorkflowVersionV3Schema,
  type AcceptedWorkflowRunV3, type CurrentWorkflowSaveInput } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { admitRepeatRun, repeatStartReceipt } from '../src/modules/runs/repeatStartAdmission.js'
import { readAcceptedRepeatRunLocked } from '../src/modules/runs/repeatStartRead.js'
import { assertSettlementLocked } from '../src/modules/runs/repeatSettlementServices.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { assertRepeatCanonicalReceiptLocked } from '../src/modules/run-graph/repeatReceipts.js'
import { readRepeatRunSourceLocked } from '../src/modules/run-graph/publication.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { agent3Database, graphHead, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

// Real, opt-in, disposable loopback PostgreSQL. The genuine v3 version is saved
// by authenticated HTTP and the typed writer; Start uses authenticated live
// principal admission + actual repeatStartPublication, not synthetic v3 INSERTs.
// This is NOT production HTTP Start/runtime/native verification. No native
// source, closure, approval ack, untyped graph fact or fake service is inserted.
// Positive native ingestion/settlement remain intentionally untested/blocked.
const enabled = postgresEnabled
describe.skipIf(!enabled)('ENG04 native proof accepted v3 PostgreSQL guard slice', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const apps: FastifyInstance[] = [], owners = new Set<RunOwnership>()
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => {
    for (const owner of owners) await owner.release()
    await Promise.all(apps.map((app) => app.close()))
    await db?.close()
  })

  async function fixture() {
    const directory = await mkdtemp(join(db.directory, 'native-proof-'))
    const f = makeCurrentWorkflowFixture(randomUUID()), entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
    f.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...f.version, definition: { ...f.version.definition,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 }, nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }],
    } }))
    await seedAgent3(db.pool, directory, f, { run: false })
    const commands = new PostgresCommandCoordinator(db.pool), access = new PostgresAccessService(db.pool)
    const scope = { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] }
    const issue = (grants: ManagementGrant[]) => access.issue({ name: 'Disposable native proof test caller',
      audience: 'operator', expiresAt: new Date(Date.now() + 300000), grants })
    // Explicit necessary actions, confined to this fixture. No all-action grant,
    // session GUC authority, database GRANT or production credential is used.
    const writer = await issue([
      { actions: ['workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save', 'runs:start', 'runs:read'], scope },
      { actions: ['agents:read', 'workspace_locations:update', 'workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } },
    ])
    const principal = await access.authenticate(writer.token)
    const locations = new WorkspaceLocationService(db.pool, commands)
    // Replace seedAgent3's synthetic location via the REAL location setter and
    // filesystem identity checks before admission. Do not mock snapshot().
    const location = await locations.set(principal, 'http', { workspaceId: f.scope.workspaceId,
      commandId: randomUUID(), expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: directory })
    const services = { commands, workflows: new WorkflowManagementService(db.pool, commands) } as OperatorServices
    const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
      checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    apps.push(app); await app.ready()
    const revision = Number((await db.pool.query<{ revision: string }>(
      'select revision::text from workflows where id=$1', [f.scope.workflowId])).rows[0]!.revision)
    const save: CurrentWorkflowSaveInput = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      commandId: randomUUID(), expectedRevision: revision, expectedWorkflowVersionId: f.version.id, executionSemanticsVersion: 3,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
      graph: { ...f.version.definition, repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] } } }
    const url = `/api/management/workspaces/${save.workspaceId}/workflows/${save.workflowId}/definition`
    const headers = (token: string) => ({ host: 'localhost', authorization: `Bearer ${token}` })
    const response = await app.inject({ method: 'PUT', url, headers: headers(writer.token), payload: save })
    assert.equal(response.statusCode, 200, response.body)
    const saved = CurrentWorkflowSaveResultSchema.parse(response.json())
    const input = RunStartV3InputSchema.parse({ workspaceId: save.workspaceId, workflowId: save.workflowId,
      workflowVersionId: saved.value.currentVersionId, expectedWorkflowRevision: saved.value.revision,
      expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds,
      expectedLocationRevision: location.value.locationRevision, commandId: randomUUID(), input: f.run.input, executionSemanticsVersion: 3 })
    const start = async (token = writer.token, request = input) => admitRepeatRun(db.pool, locations,
      await access.authenticate(token), 'http', request, repeatStartPublication)
    return { f, app, save, url, saved, writer, issue, headers, input, start, access, locations }
  }

  async function readback(run: AcceptedWorkflowRunV3) {
    return withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) => {
      const accepted = await readAcceptedRepeatRunLocked(sql, run.id)
      await assertRepeatCanonicalReceiptLocked(sql, repeatStartReceipt(run))
      const source = await readRepeatRunSourceLocked(sql, { workspaceId: run.workspaceId, workflowId: run.workflowId,
        workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 })
      assert.equal(source.replayed, true)
      assert.deepEqual(source.run, accepted.run)
      return source
    }))
  }
  async function sourceCount(runId: string) {
    return (await db.pool.query<{ n: string }>('select count(*)::text as n from run_graph_sources where run_id=$1', [runId])).rows[0]!.n
  }

  it('accepts actual typed v3, preserves canonical admission readback and exact command replay', async () => {
    const f = await fixture(), first = await f.start(), run = first.value
    assert.equal(first.replayed, false)
    assert.equal((await readback(run)).fact.type, 'repeat.run.state')
    const head = await graphHead(db.pool, run.id), count = await sourceCount(run.id)
    const replay = await admitRepeatRun(db.pool, f.locations, await f.access.authenticate(f.writer.token),
      'mcp', f.input, undefined) // Receipt-only replay does not require a runtime publisher.
    assert.deepEqual(replay, { value: run, replayed: true })
    assert.equal(await graphHead(db.pool, run.id), head); assert.equal(await sourceCount(run.id), count)
    assert.equal((await db.pool.query('select id from runs where workflow_id=$1', [run.workflowId])).rowCount, 1)
    assert.equal((await db.pool.query('select id from harness_executions where run_id=$1', [run.id])).rowCount, 0)
    assert.equal((await db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [run.id])).rowCount, 0)
    await assert.rejects(f.start(f.writer.token, { ...f.input, input: { ...f.input.input, conflict: true } }), { code: 'COMMAND_ID_CONFLICT' })
    assert.equal(await graphHead(db.pool, run.id), head)
  })

  it('denies read-only caller at authenticated writer and Start boundaries without accepting a Run', async () => {
    const f = await fixture()
    const reader = await f.issue([{ actions: ['workflows:read', 'graph:read', 'runs:read'],
      scope: { workspaceIds: [f.save.workspaceId], workflowIds: [f.save.workflowId] } }])
    const denied = await f.app.inject({ method: 'PUT', url: f.url, headers: f.headers(reader.token),
      payload: { ...f.save, commandId: randomUUID() } })
    assert.equal(denied.statusCode, 403)
    await assert.rejects(f.start(reader.token), { code: 'ACCESS_DENIED' })
    assert.equal((await db.pool.query('select id from runs where workflow_id=$1', [f.save.workflowId])).rowCount, 0)
  })

  it('cannot settle a nonexistent occurrence or reuse a released owner against a genuine accepted Run', async () => {
    const f = await fixture(), { value: run } = await f.start()
    const first = await RunOwnership.acquire(db.pool, run.id, () => undefined)
    assert.ok(first); owners.add(first)
    const head = await graphHead(db.pool, run.id), count = await sourceCount(run.id)
    await assert.rejects(first.oneShotConnection().transaction((sql) =>
      assertSettlementLocked(sql, run, ['execution-not-admitted'], first)))
    await first.release(); owners.delete(first)
    const second = await RunOwnership.acquire(db.pool, run.id, () => undefined)
    assert.ok(second); owners.add(second)
    await assert.rejects(second.oneShotConnection().transaction((sql) =>
      assertSettlementLocked(sql, run, ['execution-not-admitted'], first)))
    assert.equal(await graphHead(db.pool, run.id), head); assert.equal(await sourceCount(run.id), count)
    assert.deepEqual((await readback(run)).run, run)
  })
})
