import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { subagentsApi } from './client'
import { base, child, detail, message, scope, receipt } from './testFixtures'

const readScope = { workspaceId: scope.workspaceId, runId: scope.runId }
const input = { workspaceId: scope.workspaceId, runId: scope.runId, subagentId: 'child-1', commandId: 'command-1', expectedRevision: '4', text: 'Continue' }
describe('Subagent HTTP client', () => {
  it('sends bounded page fields and the opaque cursor through the existing client', async () => {
    let search = ''
    server.use(http.get(base, ({ request }) => {
      search = new URL(request.url).search
      return HttpResponse.json({ items: [detail()], nextCursor: null, projection: 'caught-up' })
    }))
    expect((await subagentsApi.list({ ...readScope, limit: 25, cursor: 'opaque +/=' })).items).toHaveLength(1)
    expect(new URLSearchParams(search).get('cursor')).toBe('opaque +/=')
    expect(new URLSearchParams(search).get('limit')).toBe('25')
  })
  it('rejects another Run or child rather than showing foreign evidence', async () => {
    server.use(http.get(base, () => HttpResponse.json({ items: [detail(child({ runId: 'foreign' }))], nextCursor: null, projection: 'caught-up' })))
    await expect(subagentsApi.list(readScope)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(detail(child({ id: 'foreign' })))))
    await expect(subagentsApi.detail({ ...readScope, subagentId: 'child-1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('rejects a foreign message owner and invalid transcript payload', async () => {
    server.use(http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({ items: [{ ...message(), subagentId: 'foreign' }], nextCursor: null, coverage: child().coverage })))
    await expect(subagentsApi.messages({ ...readScope, subagentId: 'child-1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    server.use(http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({ items: [{ ...message(), role: 'system' }], nextCursor: null, coverage: child().coverage })))
    await expect(subagentsApi.messages({ ...readScope, subagentId: 'child-1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('sends exact command ID and read revision, and validates the returned receipt', async () => {
    let body: unknown
    server.use(http.post(`${base}/:subagentId/input`, async ({ request }) => { body = await request.json(); return HttpResponse.json(receipt()) }))
    expect((await subagentsApi.input(input)).state).toBe('acknowledged')
    expect(body).toEqual(input)
    server.use(http.post(`${base}/:subagentId/input`, () => HttpResponse.json(receipt({ commandId: 'foreign' }))))
    await expect(subagentsApi.input(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
