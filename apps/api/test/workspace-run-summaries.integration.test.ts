import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { SavedRunPageSchema, SavedWorkflowRunSchema } from '@foreman-code/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

describe('workspace Run summaries', () => {
  it('opens with retained unsupported Runs and keeps accepted Runs readable', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const historicalIds: string[] = []
      const historicalVersions: string[] = []
      for (const [index, semantics] of [1, 2, undefined].entries()) {
        const version = { ...f.f.version, id: `historical-version-${randomUUID()}`, version: index + 2,
          executionSemanticsVersion: semantics ?? 1,
          definition: { ...f.f.version.definition, executionSemanticsVersion: semantics ?? 1, version: index + 2 } }
        historicalVersions.push(version.id)
        await f.db.pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,
          execution_semantics_version,record) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [version.id, version.workspaceId, version.workflowId, version.version, version.entryNodeId,
          version.executionSemanticsVersion, JSON.stringify(version)])
        const historical = { ...f.f.run, id: `historical-${randomUUID()}`, workflowVersionId: version.id,
          executionSemanticsVersion: semantics }
        historicalIds.push(historical.id)
        await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
          values($1,$2,$3,$4,'queued',$5::jsonb)`, [historical.id, historical.workspaceId,
          historical.workflowId, historical.workflowVersionId, JSON.stringify(historical)])
      }

      const details = await repository.getDetails(f.f.run.workspaceId, f.writer.principal)
      expect(details?.runs.map((run) => run.id)).toEqual([f.f.run.id])
      expect(details?.runs[0]).toMatchObject({ executionState: 'queued', outcome: 'pending', cleanupPending: false })
      const accepted = await f.services.runs.get(f.writer.principal, f.f.run.workspaceId, f.f.run.id)
      expect(accepted.run.id).toBe(f.f.run.id)
      expect(accepted.run.workflowVersionId).toBe(f.f.run.workflowVersionId)
      const listInput = { workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId, limit: 1 }
      const listUrl = `/api/management/workspaces/${listInput.workspaceId}/runs?workflowId=${listInput.workflowId}&limit=1`
      const listed = await f.app.inject({ method: 'GET', url: listUrl,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(listed.statusCode, listed.body).toBe(200)
      const currentPage = SavedRunPageSchema.parse(listed.json())
      expect(currentPage.items.map((run) => run.id)).toEqual([f.f.run.id])
      expect(currentPage.pageInfo.nextCursor).toBeNull()
      const remoteList = await f.client.callTool({ name: 'run_list', arguments: listInput })
      expect(remoteList.isError).not.toBe(true)
      expect(decodeMcpToolResult(remoteList)).toEqual(currentPage)
      for (const scope of [{ workflowIds: [listInput.workflowId] }, { runIds: [f.f.run.id] }]) {
        const reader = await f.access.issue({ name: 'Scoped Run reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope }] })
        const http = await f.app.inject({ method: 'GET', url: listUrl,
          headers: { authorization: `Bearer ${reader.token}` } })
        expect(http.statusCode, http.body).toBe(200)
        const page = SavedRunPageSchema.parse(http.json())
        expect(page.items.map((run) => run.id)).toEqual([f.f.run.id])
        expect(page.items[0]).not.toHaveProperty('executionLocation')
        const remote = await (await f.connect(reader.token)).callTool({ name: 'run_list', arguments: listInput })
        expect(remote.isError).not.toBe(true)
        expect(decodeMcpToolResult(remote)).toEqual(page)
      }
      for (const scope of [{ workspaceIds: ['another-workspace'] }, { workflowIds: ['another-workflow'] }]) {
        const denied = await f.access.issue({ name: 'Denied Run reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope }] })
        expect((await f.app.inject({ method: 'GET', url: listUrl,
          headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
        expect((await (await f.connect(denied.token)).callTool({ name: 'run_list', arguments: listInput })).isError).toBe(true)
      }
      for (const runId of historicalIds) {
        const scope = {
          workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId, runId,
        }
        const snapshot = { snapshot: { ...scope, kind: 'unavailable', reason: 'legacy_run' } }
        expect(await f.services.runs.history.snapshot(f.writer.principal, scope)).toEqual(snapshot)
        expect(decodeMcpToolResult((await f.client.callTool({ name: 'run_board_snapshot_get', arguments: scope }))))
          .toEqual(snapshot)
        const historicalRead = await f.app.inject({ method: 'GET',
          url: `/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/${runId}/snapshot`,
          headers: { authorization: `Bearer ${f.writer.token}` } })
        expect(historicalRead.statusCode, historicalRead.body).toBe(200)
        expect(historicalRead.json()).toEqual(snapshot)
      }
      const records = (await f.db.pool.query('select id,record from runs where id=any($1::text[]) order by id',
        [historicalIds])).rows
      const versions = (await f.db.pool.query('select id,record from workflow_versions where id=any($1::text[]) order by id',
        [historicalVersions])).rows
      expect(records).toHaveLength(3)
      await applyApplicationMigrations(f.db.pool)
      expect((await f.db.pool.query('select id,record from runs where id=any($1::text[]) order by id',
        [historicalIds])).rows).toEqual(records)
      expect((await f.db.pool.query('select id,record from workflow_versions where id=any($1::text[]) order by id',
        [historicalVersions])).rows).toEqual(versions)
      await expect(f.db.pool.query("update workflow_versions set record=record || '{\"altered\":true}'::jsonb where id=$1",
        [historicalVersions[0]])).rejects.toMatchObject({ code: '23514' })
      const invalid = { ...f.f.run, id: `invalid-${randomUUID()}`, executionSemanticsVersion: '3' }
      await expect(f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
        values($1,$2,$3,$4,'queued',$5::jsonb)`, [invalid.id, invalid.workspaceId, invalid.workflowId,
        invalid.workflowVersionId, JSON.stringify(invalid)])).rejects.toMatchObject({ code: 'P0001' })
      const invalidStart = { commandId: randomUUID(), workflowVersionId: historicalVersions[0],
        executionSemanticsVersion: 1, expectedWorkflowRevision: 1, expectedLocationRevision: 1,
        expectedAgentConfigurationVersionIds: f.f.run.agentConfigurationVersionIds, input: {} }
      const blocked = await f.app.inject({ method: 'POST',
        url: `/api/management/workspaces/${f.f.run.workspaceId}/workflows/${f.f.run.workflowId}/runs`,
        headers: { authorization: `Bearer ${f.writer.token}` }, payload: invalidStart })
      expect(blocked.statusCode).toBe(400)
      const denial = await f.client.callTool({ name: 'run_start', arguments: {
        workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId, ...invalidStart,
      } }).then(result => ({ result }), (error: unknown) => ({ error }))
      if ('error' in denial) expect(denial.error).toMatchObject({ code: -32602 })
      else expect(denial.result.isError).toBe(true)
      expect((await f.db.pool.query('select id,record from runs where id=any($1::text[]) order by id',
        [historicalIds])).rows).toEqual(records)
    } finally {
      await f.close()
    }
  }, 60000)

  it('revalidates live scope grants even when the requested Run list is empty', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const input = { workspaceId: f.f.run.workspaceId, workflowId: 'empty-workflow', limit: 1 }
      const reader = await f.access.issue({ name: 'Empty Run list reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: [input.workspaceId] } }] })
      expect((await f.services.runs.list(reader.principal, input)).items).toEqual([])
      await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [reader.principal.id, JSON.stringify([{ actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }])])
      await expect(f.services.runs.list(reader.principal, input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [reader.principal.id])
      await expect(f.services.runs.list(reader.principal, input)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally {
      await f.close()
    }
  }, 60000)

  it('uses the same query count for one and twenty completed Runs', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    const readPool = new pg.Pool({ ...f.db.pool.options, max: 1 })
    try {
      await f.services.runs.stopScheduleDispatcher()
      const repository = new PostgresWorkspaceRepository(readPool, new PostgresWorkflowRepository(readPool), f.runs)
      const finishedAt = new Date().toISOString()
      const stopCause = { kind: 'review_failure', interactionId: 'review-interaction',
        error: { code: 'REVIEW_FAILED', message: 'Review failed' }, recordedAt: finishedAt } as const
      const completed = SavedWorkflowRunSchema.parse({ ...f.f.run, executionState: 'completed',
        outcome: 'succeeded', result: { outcome: 'succeeded', output: {} }, finishedAt, stopCause })
      await f.db.pool.query("update runs set execution_state='completed',record=$2::jsonb,stop_cause=$3::jsonb where id=$1",
        [completed.id, JSON.stringify(completed), JSON.stringify(stopCause)])
      const client = await readPool.connect()
      const query = vi.spyOn(client, 'query')
      client.release()
      try {
        const short = await repository.getDetails(completed.workspaceId, f.writer.principal)
        expect(short?.runs).toHaveLength(1)
        const shortQueryCount = query.mock.calls.length
        expect(shortQueryCount).toBeGreaterThan(0)
        query.mockClear()
        for (let index = 1; index < 20; index++) {
          const historical = { ...completed, id: `completed-${randomUUID()}`,
            createdAt: new Date(Date.parse(completed.createdAt) - index * 1000).toISOString() }
          await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,
            record,created_at,runner_id,working_directory,location_revision,stop_cause)
            values($1,$2,$3,$4,'completed',$5::jsonb,$6::timestamptz,$7,$8,$9,$10::jsonb)`,
          [historical.id, historical.workspaceId, historical.workflowId, historical.workflowVersionId,
            JSON.stringify(historical), historical.createdAt, historical.executionLocation!.runnerId,
            historical.executionLocation!.rootPath, historical.executionLocation!.locationRevision, JSON.stringify(stopCause)])
        }
        const long = await repository.getDetails(completed.workspaceId, f.writer.principal)
        expect(long?.runs).toHaveLength(20)
        expect(long?.runs[0]).toMatchObject({ id: completed.id, executionState: 'completed',
          outcome: 'succeeded', finishedAt, stopCause, cleanupPending: false })
        expect(query.mock.calls.length).toBe(shortQueryCount)
      } finally {
        query.mockRestore()
      }
    } finally {
      await readPool.end()
      await f.close()
    }
  }, 60000)

  it('retains unfinished and cleanup-pending Runs beyond the recent history window', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const completedIds: string[] = []
      for (let index = 0; index < 21; index++) {
        const createdAt = new Date(Date.parse(f.f.run.createdAt) + (index + 1) * 1000).toISOString()
        const historical = SavedWorkflowRunSchema.parse({ ...f.f.run, id: `completed-${randomUUID()}`,
          createdAt, executionState: 'completed', outcome: 'succeeded', startedAt: createdAt,
          finishedAt: createdAt, result: { outcome: 'succeeded', output: {} } })
        completedIds.push(historical.id)
        await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,
          record,created_at) values($1,$2,$3,$4,'completed',$5::jsonb,$6::timestamptz)`,
        [historical.id, historical.workspaceId, historical.workflowId, historical.workflowVersionId,
          JSON.stringify(historical), createdAt])
      }
      await f.db.pool.query('insert into run_cleanup_intents(run_id) values($1)', [completedIds[0]])
      const details = await repository.getDetails(f.f.run.workspaceId, f.writer.principal)
      expect(details?.runs).toHaveLength(22)
      expect(details?.runs.find((run) => run.id === completedIds[0])).toMatchObject({ cleanupPending: true })
      expect(details?.runs.find((run) => run.id === completedIds[20])).toMatchObject({
        startedAt: expect.any(String), finishedAt: expect.any(String), cleanupPending: false,
      })
      expect(details?.runs.find((run) => run.id === f.f.run.id)).toMatchObject({ executionState: 'queued' })
    } finally {
      await f.close()
    }
  }, 60000)

  it('revalidates live read grants and refuses cached authority after narrowing or revocation', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const workspaceId = f.f.run.workspaceId
      const repository = new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs)
      const reader = await f.access.issue({ name: 'Workspace reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{
          actions: ['workspaces:read', 'workflows:read', 'agents:read', 'runs:read'],
          scope: { workspaceIds: [workspaceId] },
        }] })
      expect((await repository.getDetails(workspaceId, reader.principal))?.runs).toHaveLength(1)
      await expect(repository.getDetails('another-workspace', reader.principal)).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      })
      const records = (await f.db.pool.query('select record from runs where workspace_id=$1', [workspaceId])).rows
      await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [reader.principal.id,
        JSON.stringify([{ actions: ['workspaces:read', 'workflows:read', 'agents:read'],
          scope: { workspaceIds: [workspaceId] } }, { actions: ['runs:read'],
          scope: { workspaceIds: [workspaceId], runIds: [f.f.run.id] } }])])
      await expect(repository.getDetails(workspaceId, reader.principal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [reader.principal.id])
      await expect(repository.getDetails(workspaceId, reader.principal)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect((await f.db.pool.query('select record from runs where workspace_id=$1', [workspaceId])).rows).toEqual(records)
    } finally {
      await f.close()
    }
  }, 60000)

  it('returns the newest summaries when the active set exceeds the read cap', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [], interactions: true })
    try {
      const workspaceId = f.f.run.workspaceId
      const prefix = `queued-${randomUUID()}`
      const location = f.f.run.executionLocation!
      await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,
          record,created_at,runner_id,working_directory,location_revision)
        select $1::text || '-' || n,$2,$3,$4,'queued',
          $5::jsonb || jsonb_build_object('id',$1::text || '-' || n,'createdAt',
            to_char(('2099-01-01T00:00:00Z'::timestamptz + n * interval '1 second') at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          '2099-01-01T00:00:00Z'::timestamptz + n * interval '1 second',$6,$7,$8
        from generate_series(1,2001) as n`,
      [prefix, workspaceId, f.f.run.workflowId, f.f.run.workflowVersionId, JSON.stringify(f.f.run),
        location.runnerId, location.rootPath, location.locationRevision])
      const records = (await f.db.pool.query('select id,record from runs where workspace_id=$1 order by id',
        [workspaceId])).rows
      const response = await f.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}`,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(response.statusCode, response.body).toBe(200)
      const summaries = response.json().runs
      expect(summaries.map((run: { id: string }) => run.id)).toEqual(
        Array.from({ length: 2000 }, (_, index) => `${prefix}-${2001 - index}`),
      )
      const input = { workspaceId, workflowId: f.f.run.workflowId, limit: 1 }
      const listUrl = `/api/management/workspaces/${workspaceId}/runs?workflowId=${input.workflowId}&limit=1`
      const listed = await f.app.inject({ method: 'GET', url: listUrl,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(listed.statusCode, listed.body).toBe(200)
      const httpPage = SavedRunPageSchema.parse(listed.json())
      expect(httpPage.items.map(run => run.id)).toEqual([summaries[0].id])
      expect(httpPage.items[0]?.executionLocation).toEqual(f.f.run.executionLocation)
      const remote = await f.client.callTool({ name: 'run_list', arguments: input })
      expect(remote.isError, JSON.stringify(remote)).not.toBe(true)
      const page = SavedRunPageSchema.parse(decodeMcpToolResult(remote))
      expect(page).toEqual(httpPage)
      expect(page.items.map(run => run.id)).toEqual([summaries[0].id])
      expect(page.pageInfo.nextCursor).not.toBeNull()
      const next = await f.client.callTool({ name: 'run_list', arguments: {
        ...input, cursor: page.pageInfo.nextCursor,
      } })
      expect(next.isError).not.toBe(true)
      expect(SavedRunPageSchema.parse(decodeMcpToolResult(next)).items[0]?.id).toBe(`${prefix}-2000`)
      const nextListed = await f.app.inject({ method: 'GET',
        url: `${listUrl}&cursor=${encodeURIComponent(page.pageInfo.nextCursor!)}`,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(nextListed.statusCode, nextListed.body).toBe(200)
      expect(SavedRunPageSchema.parse(nextListed.json())).toEqual(decodeMcpToolResult(next))
      const denied = await f.access.issue({ name: 'Other workspace reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: ['other-workspace'] } }] })
      expect((await (await f.connect(denied.token)).callTool({ name: 'run_list', arguments: input })).isError)
        .toBe(true)
      expect((await f.db.pool.query('select id,record from runs where workspace_id=$1 order by id',
        [workspaceId])).rows).toEqual(records)
    } finally {
      await f.close()
    }
  }, 60000)
})
