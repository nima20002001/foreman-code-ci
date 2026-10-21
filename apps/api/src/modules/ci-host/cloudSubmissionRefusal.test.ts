import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { readCloudRun } from './cloudJournal.js'

afterEach(() => vi.restoreAllMocks())

async function submissionFixture(provider: 'github' | 'circleci') {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  const control = { failure: '', attempts: 0 }
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    const dispatch = file === 'gh' && args[0] === 'workflow' && args[1] === 'run'
      || file === 'circleci' && args[0] === 'run' && args[1] === 'trigger'
    if (dispatch) {
      control.attempts++
      if (control.failure) return { code: 1, stdout: '', stderr: control.failure }
    }
    if (file === 'circleci' && args[0] === 'api') {
      return { code: 0, stdout: JSON.stringify({ items: [], next_page_token: null }), stderr: '' }
    }
    return original(file, args, options)
  })
  return { ...f, runId, start, read, control,
    saved: () => readCloudRun(join(f.root, 'ci-cloud', 'runs', runId, 'meta.json')) }
}

it.each([
  { status: 403, phase: 'dispatch' }, { status: 429, phase: 'dispatch' },
  { status: 403, phase: 'workflow lookup' }, { status: 429, phase: 'workflow lookup' },
])('retries a GitHub HTTP $status throttle during $phase without losing backoff', async ({ status, phase }) => {
  const f = await submissionFixture('github')
  const runningId = randomUUID()
  await f.cloud.handle({ ...f.start, runId: runningId })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runningId}` }]
  const runningRead = { ...f.read, runId: runningId }
  expect(await f.cloud.handle(runningRead)).toMatchObject({ run: { state: 'running' } })
  const jobReads = f.github.jobReads.length
  const reason = status === 403 ? 'API rate limit exceeded' : 'Too Many Requests'
  f.control.failure = phase === 'dispatch'
    ? `could not create workflow dispatch event: HTTP ${status}: ${reason}. `
      + '(https://api.github.com/repos/octo/site-ci/actions/workflows/123/dispatches)'
    : `Get "https://api.github.com/repos/octo/site-ci/actions/workflows/ci.yml": HTTP ${status}: ${reason}`
  expect(await f.cloud.handle(f.start)).toMatchObject({ run: {
    state: 'starting', message: expect.stringContaining('rate limit'),
  } })
  expect(await f.saved()).toMatchObject({ dispatch: { notSent: true, uncertain: false } })
  f.control.failure = ''
  f.advance(29_999)
  expect(await f.cloud.handle(runningRead)).toMatchObject({ run: { state: 'running' } })
  expect(f.github.jobReads).toHaveLength(jobReads)
  f.advance(1)
  expect(await f.cloud.handle(runningRead)).toMatchObject({ run: { state: 'running' } })
  expect(f.github.jobReads).toHaveLength(jobReads + 1)
  f.advance(44_999)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.control.attempts).toBe(2)
  f.advance(1)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.control.attempts).toBe(3)
  expect(f.dispatched).toHaveLength(2)
})

const circleRefusals = [
  { name: 'HTTP 401', error: 'error: HTTP 401 Unauthorized' },
  { name: 'HTTP 403', error: 'error: HTTP 403 Forbidden' },
  { name: 'HTTP 404', error: 'error: HTTP 404 Not Found' },
  { name: 'JSON 401', error: JSON.stringify({ error: true, code: 'auth.token_invalid',
    message: 'The API token was rejected by CircleCI.' }) },
  { name: 'JSON 403', error: JSON.stringify({ error: true, code: 'api.error', message: 'API returned 403: Forbidden' }) },
  { name: 'JSON 404', error: JSON.stringify({ error: true, code: 'run.not_found', message: 'No run found for the project.' }) },
]

it.each(circleRefusals)('retries an explicitly refused CircleCI trigger: $name', async refusal => {
  const f = await submissionFixture('circleci')
  f.control.failure = refusal.error
  expect(await f.cloud.handle(f.start)).toMatchObject({ run: { state: 'starting' } })
  expect(await f.saved()).toMatchObject({ dispatch: { notSent: true, uncertain: false } })
  expect(f.circle.triggered).toEqual([])
  f.control.failure = ''
  f.advance(74_999)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.control.attempts).toBe(1)
  f.advance(1)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.control.attempts).toBe(2)
  expect(f.circle.triggered).toHaveLength(1)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'running' } })
})

it.each([
  'Post "https://circleci.com/api/v2/project/gh/octo/site-ci/pipeline": dial tcp 192.0.2.1:443: i/o timeout',
  'error: HTTP 503 Service Unavailable',
  'error: permission denied while contacting the API',
  JSON.stringify({ error: true, code: 'api.error', message: 'Post pipeline: context deadline exceeded' }),
  JSON.stringify({ error: true, code: 'api.error', message: 'API returned 503: Service Unavailable' }),
  '{"error":true,"code":"auth.token_invalid",',
])('retains uncertain ownership for an ambiguous CircleCI trigger failure: %s', async failure => {
  const f = await submissionFixture('circleci')
  f.control.failure = failure
  await expect(f.cloud.handle(f.start)).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
  expect(await f.saved()).toMatchObject({ dispatch: { notSent: false, uncertain: true } })
  f.advance(30 * 60_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.control.attempts).toBe(1)
  expect(f.circle.triggered).toEqual([])
})
