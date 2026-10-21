import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SavedRunPageSchema, SavedWorkflowRunSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
type Reader = Awaited<ReturnType<typeof reader>>
type ListInput = { workspaceId: string; workflowId?: string; cursor?: string; limit: number }

async function reader(f: Fixture, grants: ManagementPrincipal['grants']) {
  const issued = await f.access.issue({ name: 'Run list reader', audience: 'operator', grants,
    expiresAt: new Date(Date.now() + 600000) })
  return { ...issued, client: await f.connect(issued.token) }
}

async function insertRun(f: Fixture, id: string, createdAt: string) {
  const run = SavedWorkflowRunSchema.parse({ ...f.f.run, id, createdAt })
  await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,
    record,created_at,runner_id,working_directory,location_revision)
    values($1,$2,$3,$4,'queued',$5::jsonb,$6::timestamptz,$7,$8,$9)`,
  [id, run.workspaceId, run.workflowId, run.workflowVersionId, JSON.stringify(run), createdAt,
    run.executionLocation!.runnerId, run.executionLocation!.rootPath, run.executionLocation!.locationRevision])
  return run
}

function listUrl(input: ListInput) {
  const { workspaceId, ...query } = input
  const parameters = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))
  return `/api/management/workspaces/${encodeURIComponent(workspaceId)}/runs?${parameters}`
}

async function page(f: Fixture, r: Reader, input: ListInput) {
  const http = await f.app.inject({ method: 'GET', url: listUrl(input),
    headers: { authorization: `Bearer ${r.token}` } })
  expect(http.statusCode, http.body).toBe(200)
  const mcp = await r.client.callTool({ name: 'run_list', arguments: input })
  expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true)
  const result = SavedRunPageSchema.parse(decodeMcpToolResult(mcp))
  expect(http.json()).toEqual(result)
  expect(result.items.every((run) => run.executionLocation === undefined
    && run.authorizationPrincipalId === undefined)).toBe(true)
  return result
}

describe('chronological Run list pagination', () => {
  it('pages newest-first across reversed IDs, microseconds, ties, lifecycle changes and newer admissions', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const workspaceId = f.f.run.workspaceId
      const workflowId = f.f.run.workflowId
      const prefix = randomUUID()
      const ids = ['z', 'b', 'c', 'a'].map((suffix) => `run-${prefix}-${suffix}`)
      for (const [index, id] of ids.entries()) {
        await insertRun(f, id, `2030-01-01T00:00:00.${['123455', '123456', '123456', '123457'][index]}Z`)
      }
      const r = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: [workspaceId] } }])
      const tools = (await r.client.listTools()).tools
      expect(tools.find((tool) => tool.name === 'run_list')?.annotations?.readOnlyHint).toBe(true)
      expect(tools.map((tool) => tool.name)).not.toContain('run_start')
      const input = { workspaceId, limit: 2 }
      const first = await page(f, r, input)
      expect(first.items.map((run) => run.id)).toEqual([ids[3], ids[2]])
      expect(first.pageInfo.nextCursor).not.toBeNull()
      expect((await page(f, r, { ...input, workflowId })).items.map((run) => run.id)).toEqual([ids[3], ids[2]])
      const newer = await insertRun(f, `newer-${randomUUID()}`, '2031-01-01T00:00:00.000001Z')
      await f.db.pool.query("update runs set execution_state='running',record=record || $2::jsonb where id=$1",
        [ids[1], JSON.stringify({ executionState: 'running', startedAt: '2032-01-01T00:00:00.000Z' })])
      const before = (await f.db.pool.query('select id,record from runs where workspace_id=$1 order by id',
        [workspaceId])).rows
      const items = [...first.items]
      const cursors = new Set<string>()
      let cursor = first.pageInfo.nextCursor
      for (let count = 0; cursor && count < 10; count++) {
        expect(cursors.has(cursor)).toBe(false)
        cursors.add(cursor)
        const next = await page(f, r, { ...input, cursor })
        items.push(...next.items)
        cursor = next.pageInfo.nextCursor
      }
      expect(cursor).toBeNull()
      expect(items.map((run) => run.id)).toEqual([ids[3], ids[2], ids[1], ids[0], f.f.run.id])
      expect(new Set(items.map((run) => run.id)).size).toBe(items.length)
      expect(items.find((run) => run.id === ids[1])).toMatchObject({ executionState: 'running' })
      expect(items.some((run) => run.id === newer.id)).toBe(false)
      expect((await f.db.pool.query('select id,record from runs where workspace_id=$1 order by id',
        [workspaceId])).rows).toEqual(before)
    } finally {
      await f.close()
    }
  }, 60000)

  it('reads committed Run facts through HTTP and MCP while lifecycle and pin rows are locked', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    const blocker = await f.db.pool.connect()
    let deadline: ReturnType<typeof setTimeout> | undefined
    let pending: ReturnType<typeof page> | undefined
    try {
      const run = f.f.run
      const r = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: [run.workspaceId] } }])
      await blocker.query('begin')
      await blocker.query('select id from runs where id=$1 for update', [run.id])
      await blocker.query('select id from workflow_versions where id=$1 for update', [run.workflowVersionId])
      await blocker.query('select id from agent_configuration_versions where id=any($1::text[]) for update',
        [Object.values(run.agentConfigurationVersionIds)])
      pending = page(f, r, { workspaceId: run.workspaceId, limit: 10 })
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Run list waited for lifecycle locks')), 2000)
        }),
      ])
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({ id: run.id, executionState: run.executionState })
      expect((await f.db.pool.query('select record from runs where id=$1', [run.id])).rows[0]!.record)
        .toEqual(run)
    } finally {
      if (deadline) clearTimeout(deadline)
      await blocker.query('rollback')
      blocker.release()
      // Settle both transports after releasing the blocker even if the deadline failed.
      await pending?.catch(() => undefined)
      await f.close()
    }
  }, 60000)

  it('filters beyond unauthorized pages, rejects foreign cursors and rechecks live grants', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const workspaceId = f.f.run.workspaceId
      const ids: string[] = []
      for (let index = 0; index < 105; index++) {
        const id = `run-${randomUUID()}`
        ids.push(id)
        await insertRun(f, id, new Date(Date.UTC(2030, 0, 1) + index * 1000).toISOString())
      }
      const r = await reader(f, [{ actions: ['runs:read'], scope: {
        workspaceIds: [workspaceId], runIds: [ids[0]!, ids[1]!],
      } }])
      const input = { workspaceId, limit: 1 }
      const first = await page(f, r, input)
      expect(first.items.map((run) => run.id)).toEqual([ids[1]])
      const cursor = first.pageInfo.nextCursor!
      const last = await page(f, r, { ...input, cursor })
      expect(last.items.map((run) => run.id)).toEqual([ids[0]])
      expect(last.pageInfo.nextCursor).toBeNull()

      const foreign = { ...input, cursor, workflowId: f.f.run.workflowId }
      const badCursor = await f.app.inject({ method: 'GET', url: listUrl(foreign),
        headers: { authorization: `Bearer ${r.token}` } })
      expect(badCursor.statusCode).toBe(400)
      expect(badCursor.json()).toMatchObject({ error: { code: 'RUN_HISTORY_CURSOR_INVALID' } })
      expect((await r.client.callTool({ name: 'run_list', arguments: foreign })).isError).toBe(true)

      const denied = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      expect((await f.app.inject({ method: 'GET', url: listUrl(input),
        headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      const refused = await denied.client.callTool({ name: 'run_list', arguments: input })
      expect(refused.isError).toBe(true)
      const body = refused.content.find((item) => item.type === 'text')
      expect(JSON.parse(body!.text as string)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [r.principal.id, JSON.stringify([{ actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }])])
      await expect(f.services.runs.list(r.principal, input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [r.principal.id])
      await expect(f.services.runs.list(r.principal, input)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally {
      await f.close()
    }
  }, 60000)
})
