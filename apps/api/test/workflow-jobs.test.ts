import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkflowJobListInputSchema } from '@foreman-code/contracts/job-verification'
import { localHumanPrincipal } from '../src/modules/access/localHuman.js'
import { registerJobRoutes } from '../src/routes/jobs.js'
import type { JobService } from '../src/modules/jobs/service.js'
import { DomainError } from '../src/modules/errors.js'
import { jobCapabilities } from '../src/mcp/operator/tools/jobs.js'
import type { JobMcpContext } from '../src/mcp/operator/tools/jobs.js'

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
function fixture() {
  const app = Fastify()
  apps.push(app)
  app.addHook('preHandler', async request => { request.operatorPrincipal = localHumanPrincipal })
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof DomainError ? error.status : 400
    reply.status(status).send({ error: { message: error instanceof Error ? error.message : 'Invalid request' } })
  })
  const list = vi.fn(async (_principal, workspaceId, workflowId) => ({ workspaceId, workflowId, items: [], nextCursor: null }))
  registerJobRoutes(app, { listWorkflowExecutions: list } as unknown as JobService)
  return { app, list }
}
const path = '/api/management/workspaces/workspace-a/jobs/workflows/workflow-a/executions'
it('reads one workflow with the shared default page size', async () => {
  const { app, list } = fixture()
  const result = await app.inject({ method: 'GET', url: path })
  expect(result.statusCode).toBe(200)
  expect(result.json()).toEqual({ workspaceId: 'workspace-a', workflowId: 'workflow-a', items: [], nextCursor: null })
  expect(list).toHaveBeenCalledWith(localHumanPrincipal, 'workspace-a', 'workflow-a', { limit: 50 })
})
it('passes the validated cursor and limit to the shared read service', async () => {
  const { app, list } = fixture()
  const cursor = { createdAt: '2026-10-01T00:00:00Z', id: 'job-a' }
  const result = await app.inject({ method: 'GET', url: `${path}?limit=2&cursor=${encodeURIComponent(JSON.stringify(cursor))}` })
  expect(result.statusCode).toBe(200)
  expect(list).toHaveBeenCalledWith(localHumanPrincipal, 'workspace-a', 'workflow-a', { limit: 2, cursor })
})
it.each(['limit=0', 'limit=51', 'limit=invalid', 'cursor=invalid', 'cursor=null', 'cursor=%7B%7D', 'unknown=true'])(
  'rejects invalid paging %s without reading jobs', async query => {
    const { app, list } = fixture()
    const result = await app.inject({ method: 'GET', url: `${path}?${query}` })
    expect(result.statusCode).toBe(400)
    expect(list).not.toHaveBeenCalled()
  })
it('exposes workflow history with jobs:read capability and denies an ungranted caller', () => {
  const context = { principal: localHumanPrincipal, services: { jobs: {}, commands: {} } } as JobMcpContext
  const capability = jobCapabilities(context, { workspaceId: 'workspace-a', workflowId: 'workflow-a' })
    .find(item => item.name === 'job_workflow_list')
  expect(capability).toMatchObject({ actions: ['jobs:read'] })
  expect(capability?.detail).toContain('cursor paging')
  expect(jobCapabilities({ ...context, principal: { ...localHumanPrincipal, grants: [] } }, {}))
    .not.toContainEqual(expect.objectContaining({ name: 'job_workflow_list' }))
})
it('uses the same page input contract for HTTP and MCP', () => {
  expect(WorkflowJobListInputSchema.parse({})).toEqual({ limit: 50 })
  expect(WorkflowJobListInputSchema.safeParse({ cursor: { createdAt: 'invalid', id: 'job-a' } }).success).toBe(false)
})
