import { expect, it, vi } from 'vitest'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

const run: CloudRun = {
  runId: 'ticket', repository: 'fixture/site', mirror: 'fixture/site-ci', commit: 'a'.repeat(40),
  suite: 'integration', providerRunId: 'pipeline', state: 'starting',
  startedAt: '2026-10-01T00:00:00Z', finishedAt: null, exitCode: null, message: null,
}

function fixture() {
  const command = vi.fn<HostCiPorts['run']>(async () => { throw new Error('Unexpected CLI request') })
  const ports: HostCiPorts = { run: command, now: () => new Date(run.startedAt), cpus: 4, memoryBytes: 2 ** 30 }
  const control = { jobStatus: 404, pipelineStatus: 200, workflowStatus: 'running' }
  const fetchCircle: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path === '/api/v2/pipeline/pipeline') {
      return Response.json({ state: 'created', errors: [] }, { status: control.pipelineStatus })
    }
    if (path === '/api/v2/pipeline/pipeline/workflow') {
      return Response.json({ items: [{ id: 'workflow', status: control.workflowStatus }] })
    }
    if (path === '/api/v2/workflow/workflow/job') {
      if (control.jobStatus !== 200) return Response.json({ message: 'Not Found' }, { status: control.jobStatus })
      return Response.json({ items: [{ id: 'job' }] })
    }
    if (path === '/api/v3/jobs/job') {
      return Response.json({ data: { attributes: { phase: 'ended', outcome: 'succeeded',
        ended_at: '2026-10-01T00:01:00Z', parallel_executions: [] } } })
    }
    throw new Error(`Unexpected CircleCI request: ${path}`)
  }
  const provider = new CircleCiProvider(ports, { fetch: fetchCircle, circleToken: async () => 'fixture-token' })
  return { provider, command, control }
}

it('discovers a created workflow while its jobs endpoint is not visible, then reads its result', async () => {
  const f = fixture()
  await expect(f.provider.find(run)).resolves.toBe('pipeline')
  await expect(f.provider.status(run)).resolves.toMatchObject({ done: false })

  f.control.jobStatus = 200
  f.control.workflowStatus = 'success'
  await expect(f.provider.status(run)).resolves.toMatchObject({ done: true, conclusion: 'success' })
  expect(f.command).not.toHaveBeenCalled()
})

it('still reports a missing pipeline as an invisible run', async () => {
  const f = fixture()
  f.control.pipelineStatus = 404
  await expect(f.provider.find(run)).rejects.toMatchObject({ code: 'CI_CLOUD_RUN_NOT_FOUND' })
})

it('keeps a denied jobs lookup visible instead of treating it as a pending job list', async () => {
  const f = fixture()
  f.control.jobStatus = 403
  await expect(f.provider.find(run)).rejects.toMatchObject({ code: 'CI_CLOUD_RUN_UNREADABLE' })
})
