import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { runsSelectorApi, runSnapshotPath, runSummariesPath } from './client'
import { page, runA, scope, snapshot } from './testFixtures'

const listRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries'
const snapshotRoute = listRoute.replace(/\/summaries$/, '/:runId/snapshot')

describe('Runs HTTP client boundary', () => {
  it('uses the authenticated real client, a bounded limit and an opaque encoded cursor', async () => {
    let observed: Request | undefined
    server.use(http.get(listRoute, ({ request }) => { observed = request; return HttpResponse.json(page([runA])) }))
    const result = await runsSelectorApi.list({ ...scope, cursor: 'opaque:/+?=&', limit: 25 })
    expect(result.items).toEqual([runA])
    expect(observed?.credentials).toBe('omit')
    const url = new URL(observed!.url)
    expect(url.pathname).toBe(`/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/summaries`)
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.get('cursor')).toBe('opaque:/+?=&')
  })

  it('encodes every path identity', () => {
    const target = { workspaceId: 'space/a', workflowId: 'flow?b' }
    expect(runSummariesPath(target)).toBe('/api/management/workspaces/space%2Fa/workflows/flow%3Fb/runs/summaries')
    expect(runSnapshotPath({ ...target, runId: 'run/#?' })).toBe('/api/management/workspaces/space%2Fa/workflows/flow%3Fb/runs/run%2F%23%3F/snapshot')
  })

  it.each(['workspaceId', 'workflowId', 'runId'] as const)('rejects a snapshot for the wrong %s', async (field) => {
    const result = snapshot('run-a')
    server.use(http.get(snapshotRoute, () => HttpResponse.json({ snapshot: { ...result.snapshot, [field]: 'wrong' } })))
    await expect(runsSelectorApi.snapshot({ ...scope, runId: 'run-a' }))
      .rejects.toMatchObject({ code: 'RUN_SELECTION_MISMATCH', status: 409 })
  })

  it('rejects oversized and malformed summary pages instead of rendering them', async () => {
    server.use(http.get(listRoute, () => HttpResponse.json(page(Array.from({ length: 26 }, (_, index) => ({ ...runA, runId: `run-${index}` }))))))
    await expect(runsSelectorApi.list({ ...scope, limit: 25 })).rejects.toMatchObject({ code: 'RUN_PAGE_TOO_LARGE' })
    server.use(http.get(listRoute, () => HttpResponse.json({ items: [{ ...runA, status: 'unknown' }], pageInfo: { nextCursor: null } })))
    await expect(runsSelectorApi.list({ ...scope, limit: 25 })).rejects.toBeInstanceOf(Error)
  })

  it('retains forbidden and missing status codes rather than treating them as empty data', async () => {
    server.use(http.get(listRoute, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 })),
      http.get(snapshotRoute, () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'No Run' } }, { status: 404 })))
    await expect(runsSelectorApi.list({ ...scope, limit: 25 })).rejects.toMatchObject({ status: 403 })
    await expect(runsSelectorApi.snapshot({ ...scope, runId: 'run-a' })).rejects.toMatchObject({ status: 404 })
  })
})
