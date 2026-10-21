import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { currentWorkflowWriterMigration } from '../src/infrastructure/currentWorkflowWriterMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunHistoryService } from '../src/modules/runs/history.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

describe.skipIf(!postgresEnabled)('historical database upgrade', () => {
  it('migrates retained versions through the pending writer and preserves authenticated Run readback', async () => {
    const db = await currentDatabase({ beforeMigration: currentWorkflowWriterMigration.version })
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const scopes: Array<{ workspaceId: string; workflowId: string; runId: string }> = []
      for (const semantics of [1, 2] as const) {
        const f = makeCurrentWorkflowFixture(randomUUID(), 'single')
        const version = { ...f.version, executionSemanticsVersion: semantics,
          definition: { ...f.version.definition, executionSemanticsVersion: semantics } }
        const run = { ...f.run, executionSemanticsVersion: semantics }
        await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
          [f.scope.workspaceId, JSON.stringify({ id: f.scope.workspaceId, name: 'Historical workspace' })])
        await db.pool.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
          [f.scope.workflowId, f.scope.workspaceId, JSON.stringify(version.definition)])
        await db.pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,
          execution_semantics_version,record) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [version.id, version.workspaceId, version.workflowId, version.version, version.entryNodeId,
          semantics, JSON.stringify(version)])
        await db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
          values($1,$2,$3,$4,$5,$6::jsonb)`,
        [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, run.executionState, JSON.stringify(run)])
        scopes.push({ workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id })
      }
      const records = async () => ({
        versions: (await db.pool.query(`select id,workspace_id,workflow_id,version,entry_node_id,
          execution_semantics_version,record from workflow_versions order by id`)).rows,
        runs: (await db.pool.query(`select id,workspace_id,workflow_id,workflow_version_id,
          execution_state,record from runs order by id`)).rows,
      })
      const retained = await records()
      await applyApplicationMigrations(db.pool)
      expect(await records()).toEqual(retained)
      await applyApplicationMigrations(db.pool)
      expect(await records()).toEqual(retained)

      const access = new PostgresAccessService(db.pool)
      const reader = await access.issue({ name: 'Historical reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: {} }], expiresAt: new Date(Date.now() + 300000) })
      const denied = await access.issue({ name: 'Denied historical reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }],
        expiresAt: new Date(Date.now() + 300000) })
      const history = new RunHistoryService(db.pool)
      const commands = new PostgresCommandCoordinator(db.pool)
      app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
        checkpoints: { ping: async () => undefined } },
      operator: { access, services: { runs: { history }, commands } as unknown as OperatorServices } })
      for (const scope of scopes) {
        const url = `/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}`
          + `/runs/${scope.runId}/snapshot`
        const expected = { snapshot: { ...scope, kind: 'unavailable', reason: 'legacy_run' } }
        const http = await app.inject({ method: 'GET', url, headers: graphHeaders(reader.token) })
        expect(http.statusCode, http.body).toBe(200)
        expect(http.json()).toEqual(expected)
        const remote = await graphRpc(app, reader.token, 'tools/call', {
          name: 'run_board_snapshot_get', arguments: scope,
        })
        expect(remote.result?.isError).not.toBe(true)
        expect(graphRpcValue(remote.result)).toEqual(expected)
        expect((await app.inject({ method: 'GET', url, headers: graphHeaders(denied.token) })).statusCode).toBe(403)
        const rejected = await graphRpc(app, denied.token, 'tools/call', {
          name: 'run_board_snapshot_get', arguments: scope,
        })
        expect(rejected.result?.isError).toBe(true)
        expect(graphRpcValue(rejected.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      }
      expect(await records()).toEqual(retained)
      await expect(db.pool.query('update workflow_versions set version=version+1 where id=$1',
        [retained.versions[0]!.id])).rejects.toMatchObject({ code: '23514' })
      await expect(db.pool.query('delete from workflow_versions where id=$1',
        [retained.versions[0]!.id])).rejects.toMatchObject({ code: '23514' })
    } finally {
      await app?.close()
      await db.close()
    }
  }, 60000)
})
