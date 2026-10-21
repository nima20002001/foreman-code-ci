import { it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { jobsClient } from './client'
import { definition, execution, logPage, queueTicket, verificationDefinition } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs'

it('reads saved definitions and immutable versions for Board job nodes', async () => {
  server.use(
    http.get(`${root}/definitions`, () => HttpResponse.json({ definitions: [definition, verificationDefinition] })),
    http.get(`${root}/definitions/:id/versions/:version`, () => HttpResponse.json({ definition: verificationDefinition })),
  )
  expect(await jobsClient.definitions(definition.workspaceId)).toEqual([definition, verificationDefinition])
  expect(await jobsClient.definitionVersion(definition.workspaceId, verificationDefinition.id,
    verificationDefinition.versionId)).toEqual(verificationDefinition)
  await expect(jobsClient.definitions('foreign')).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
  await expect(jobsClient.definitionVersion(definition.workspaceId, verificationDefinition.id, 'foreign-version'))
    .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
})

it('reads scoped Agent activity queue pages and preserves the history cursor', async () => {
  let seen: URL | undefined
  server.use(http.get(`${root}/queue`, ({ request }) => {
    seen = new URL(request.url)
    return HttpResponse.json({ tickets: [queueTicket], nextHistoryCursor: '12' })
  }))
  expect(await jobsClient.queuePage(definition.workspaceId, { historyBeforeSequence: '20' }))
    .toEqual({ tickets: [queueTicket], nextHistoryCursor: '12' })
  expect(seen?.searchParams.get('historyBeforeSequence')).toBe('20')
  await expect(jobsClient.queuePage('foreign')).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
})

it('rejects a stale or cross-workspace execution', async () => {
  server.use(http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution })))
  expect(await jobsClient.execution(execution.workspaceId, execution.id)).toEqual(execution)
  await expect(jobsClient.execution('workspace-b', execution.id)).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
  await expect(jobsClient.execution(execution.workspaceId, 'execution-b'))
    .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
})

it('filters workflow-wide queue reads and rejects tickets from a foreign workflow', async () => {
  let seen: URL | undefined
  const ticket = { ...queueTicket,
    initiatingAgent: { workflowId: 'workflow-a', runId: 'run-a', agentId: 'agent-a', executionId: 'agent-exec-a' } }
  server.use(http.get(`${root}/queue`, ({ request }) => {
    seen = new URL(request.url)
    return HttpResponse.json({ tickets: [ticket], nextHistoryCursor: null })
  }))
  expect(await jobsClient.queuePage(definition.workspaceId, { workflowId: 'workflow-a' }))
    .toEqual({ tickets: [ticket], nextHistoryCursor: null })
  expect(seen?.searchParams.get('workflowId')).toBe('workflow-a')
  await expect(jobsClient.queuePage(definition.workspaceId, { workflowId: 'foreign' }))
    .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
})

it('enforces bounded cursor pages and rejects another attempt', async () => {
  let seen: Request | undefined
  server.use(http.get(`${root}/executions/:id/logs`, ({ request }) => {
    seen = request
    return HttpResponse.json(logPage)
  }))
  await jobsClient.logs(execution.workspaceId, execution.id, execution.attemptId, 0)
  expect(new URL(seen!.url).searchParams.get('limit')).toBe('50')
  expect(seen!.credentials).toBe('omit')
  expect(seen!.headers.has('Authorization')).toBe(false)
  await expect(jobsClient.logs(execution.workspaceId, execution.id, 'attempt-b', 0))
    .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
})

it('retains explicit forbidden status', async () => {
  server.use(http.get(`${root}/executions/:id`, () => HttpResponse.json({
    error: { code: 'FORBIDDEN', message: 'Denied' },
  }, { status: 403 })))
  await expect(jobsClient.execution(execution.workspaceId, execution.id)).rejects.toMatchObject({ status: 403 })
})
