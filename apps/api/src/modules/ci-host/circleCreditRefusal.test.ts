import { expect, it } from 'vitest'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

const run: CloudRun = { runId: 'ticket', repository: 'fixture/site', mirror: 'alpha/site-ci',
  commit: 'a'.repeat(40), suite: 'lint', startedAt: '2026-10-21T00:00:00.000Z',
  providerRunId: 'pipeline', state: 'starting', finishedAt: null, exitCode: null, message: null }

function provider(message: string) {
  const reads: string[] = []
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(),
    run: async () => { throw new Error('Unexpected CLI fallback') } }
  const circle = new CircleCiProvider(ports, { circleToken: async () => 'fixture-token', fetch: async input => {
    const path = new URL(String(input)).pathname
    reads.push(path)
    if (path === '/api/v2/pipeline/pipeline') {
      return Response.json({ state: 'created', project_slug: 'gh/alpha/site-ci', errors: [] })
    }
    if (path === '/api/v2/pipeline/pipeline/workflow') {
      return Response.json({ items: [{ id: 'workflow', status: 'not_run' }], next_page_token: null })
    }
    if (path === '/api/v2/workflow/workflow/job') {
      return Response.json({ items: [{ id: 'job', job_number: 42, status: 'not_run' }], next_page_token: null })
    }
    if (path === '/api/v1.1/project/gh/alpha/site-ci/42') {
      return Response.json({ status: 'not_run', messages: [{ type: 'error', message }] })
    }
    if (path === '/api/v3/jobs/job') {
      return Response.json({ data: { attributes: { name: 'ci', phase: 'ended', outcome: 'not_run' } } })
    }
    throw new Error(`Unexpected CircleCI read: ${path}`)
  } })
  return { circle, reads }
}

it('recognizes an explicit credit refusal on a not-run job through CircleCI HTTP responses', async () => {
  const f = provider('This job has been blocked because no credits are available on your plan.')
  await expect(f.circle.status(run)).rejects.toMatchObject({ code: 'CI_CLOUD_PIPELINE_FAILED',
    details: { creditRefused: true, configError: false } })
  expect(f.reads).toContain('/api/v1.1/project/gh/alpha/site-ci/42')
})

it('does not treat a skipped dependency as a credit refusal', async () => {
  const f = provider('Dependencies failed; job was not run.')
  expect(await f.circle.status(run)).toMatchObject({ done: true, conclusion: 'failure' })
})
