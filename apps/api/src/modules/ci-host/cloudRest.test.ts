import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { CLOUD_START_TIMEOUT_MS, GitHubActionsProvider, CircleCiProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'
import { withProviderPoll } from './providerPoll.js'
import { packEntries } from '../files/archives/zip.js'
import { Budget } from '../files/archives/policy.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const run: CloudRun = {
  runId: 'ticket', repository: 'octo/site', mirror: 'octo/site-ci', commit: 'abc', suite: 'unit',
  startedAt: '2026-10-01T00:00:00Z', providerRunId: '42', state: 'running',
  finishedAt: null, exitCode: null, message: null,
}
const finishedAt = '2026-10-01T00:01:00Z'

async function http(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: { url: string; authorization: string | undefined; etag: string | undefined }[] = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, authorization: request.headers.authorization,
      etag: request.headers['if-none-match'] })
    handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address() as { port: number }
  const fetchLocal: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
  }
  return { fetch: fetchLocal, requests }
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
function ports(tokens = ['test-token']) {
  let tokenRead = 0
  const calls = vi.fn<HostCiPorts['run']>(async (file, args) => {
    if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
      const token = tokens[Math.min(tokenRead++, tokens.length - 1)]
      return { code: token ? 0 : 1, stdout: token ?? '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected CLI read' }
  })
  const value: HostCiPorts = { run: calls, now: () => new Date(finishedAt), cpus: 4, memoryBytes: 2 ** 30 }
  return { value, calls }
}
async function directory() {
  const root = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true })
  const path = await mkdtemp(join(root, 'ci-rest-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function zip(files: Record<string, string>) {
  return packEntries(Object.entries(files).map(([name, text]) => ({ name, bytes: Buffer.from(text) })), new Budget())
}

it('shares one GitHub token across concurrent providers and retains conditional job status', async () => {
  const server = await http((request, response) => {
    if (request.headers['if-none-match']) {
      response.writeHead(304)
      response.end()
      return
    }
    response.setHeader('ETag', '"jobs"')
    json(response, { jobs: [{ id: 8, status: 'in_progress', steps: [
      { number: 1, name: 'Tests', status: 'in_progress', conclusion: null },
    ] }] })
  })
  const cli = ports()
  const first = new GitHubActionsProvider(cli.value, server)
  const second = new GitHubActionsProvider(cli.value, server)
  const expected = { done: false, steps: [{ key: '8:1', name: 'Tests', state: 'running' }] }
  expect(await Promise.all([first.status(run), second.status({ ...run, providerRunId: '43' })]))
    .toEqual([expected, expected])
  expect(await first.status(run)).toEqual(expected)
  expect(cli.calls).toHaveBeenCalledTimes(1)
  expect(server.requests.at(-1)?.etag).toBe('"jobs"')
  expect(server.requests.every(request => request.authorization === 'Bearer test-token')).toBe(true)
})

it('refreshes a rejected GitHub token once and reads terminal conclusions', async () => {
  const server = await http((request, response) => {
    if (request.headers.authorization === 'Bearer expired') return json(response, { message: 'Bad credentials' }, 401)
    if (request.url!.includes('/jobs')) return json(response, { jobs: [{ id: 8, status: 'completed' }] })
    json(response, { status: 'completed', conclusion: 'cancelled', updated_at: finishedAt })
  })
  const cli = ports(['expired', 'replacement'])
  const provider = new GitHubActionsProvider(cli.value, server)
  expect(await provider.status(run)).toEqual({ done: true, conclusion: 'cancelled', finishedAt, steps: [] })
  expect(cli.calls).toHaveBeenCalledTimes(2)
  expect(server.requests.at(-1)?.authorization).toBe('Bearer replacement')
})

it('finds GitHub runs on the second REST page and shares the listing within a poll', async () => {
  const server = await http((request, response) => {
    const second = request.url!.includes('page=2')
    json(response, { workflow_runs: second ? [{ id: 42, display_title: 'ci ticket', head_sha: 'abc' }]
      : Array.from({ length: 100 }, (_, id) => ({ id, display_title: 'other', head_sha: 'abc' })) })
  })
  const cli = ports()
  const provider = new GitHubActionsProvider(cli.value, server)
  expect(await withProviderPoll(() => Promise.all([provider.find(run), provider.find(run)]))).toEqual(['42', '42'])
  expect(server.requests).toHaveLength(2)
  expect(cli.calls).toHaveBeenCalledTimes(1)
})

it('keeps the CLI fallback when no GitHub token is available', async () => {
  const server = await http((_request, response) => json(response, {}, 500))
  const cli = ports([''])
  cli.calls.mockImplementation(async (_file, args) => args[0] === 'auth'
    ? { code: 1, stdout: '', stderr: '' }
    : { code: 0, stdout: 'original log\n', stderr: '' })
  expect(await new GitHubActionsProvider(cli.value, server).log(run)).toBe('original log\n')
  expect(server.requests).toEqual([])
})

it.each([403, 429])('preserves GitHub rate-limit errors for HTTP %s', async status => {
  const server = await http((_request, response) => {
    response.setHeader('X-RateLimit-Remaining', '0')
    json(response, { message: 'API rate limit exceeded' }, status)
  })
  const cli = ports()
  await expect(new GitHubActionsProvider(cli.value, server).status(run)).rejects.toMatchObject({
    code: 'CI_CLOUD_RATE_LIMITED', message: 'GitHub Actions rate limit reached; polling paused.',
  })
  expect(cli.calls).toHaveBeenCalledTimes(1)
})

it('downloads GitHub artifact archives and preserves structured results', async () => {
  const durations = { 'feature.test.ts': 123 }
  const testResults = { files: [] }
  const archive = await zip({ 'reports/durations.json': JSON.stringify(durations),
    'reports/test-results.json': JSON.stringify(testResults), 'reports/watchdog-message.json': '"watchdog"' })
  const server = await http((request, response) => {
    if (request.url!.endsWith('/zip')) {
      response.writeHead(302, { Location: 'https://downloads.example/archive' })
      response.end()
    } else if (request.url === '/archive') {
      response.end(archive)
    } else json(response, { artifacts: [{ id: 7, name: 'durations', expired: false }] })
  })
  const cli = ports()
  expect(await new GitHubActionsProvider(cli.value, server).artifacts(run, await directory()))
    .toEqual({ durations, testResults, integrationCoverage: null, selection: null, watchdogFailure: 'watchdog' })
  expect(server.requests.at(-1)?.authorization).toBeUndefined()
  expect(cli.calls).toHaveBeenCalledTimes(1)
})

it('returns absent GitHub artifacts without a download', async () => {
  const server = await http((_request, response) => json(response, { artifacts: [] }))
  expect(await new GitHubActionsProvider(ports().value, server).artifacts(run, await directory()))
    .toEqual({ durations: null, testResults: null })
  expect(server.requests).toHaveLength(1)
})

it('formats GitHub job logs with the same job and step labels', async () => {
  const archive = await zip({ 'Tests/1_Run tests.txt': '2026-10-01T00:00:00Z failure\n' })
  const server = await http((request, response) => {
    if (request.url!.includes('/jobs')) return json(response, { jobs: [{ id: 8, name: 'Tests', status: 'completed',
      steps: [{ number: 1, name: 'Run tests', status: 'completed', conclusion: 'failure' }] }] })
    response.end(archive)
  })
  const cli = ports()
  expect(await new GitHubActionsProvider(cli.value, server).log(run))
    .toBe('Tests\tRun tests\t2026-10-01T00:00:00Z failure\n')
  expect(cli.calls).toHaveBeenCalledTimes(1)
})

function circleHandler(request: IncomingMessage, response: ServerResponse) {
  if (request.url === '/api/v2/pipeline/42') return json(response, { state: 'created', errors: [] })
  if (request.url === '/api/v2/pipeline/42/workflow') return json(response,
    { items: [{ id: 'workflow', status: 'running' }], next_page_token: null })
  if (request.url === '/api/v2/workflow/workflow/job') return json(response,
    { items: [{ id: 'job', job_number: 12, status: 'running' }], next_page_token: null })
  if (request.url === '/api/v3/jobs/job') return json(response, { data: { id: 'job', attributes: {
    name: 'Tests', phase: 'started', parallel_executions: [{ steps: [
      { num: 1, name: 'Tests', phase: 'started' },
    ] }],
  } } })
  if (request.url!.includes('/stdout')) return response.end('\u001b[31mfailure\u001b[0m\n')
  if (request.url!.includes('/stderr')) return response.end('details\n')
  json(response, {}, 404)
}

// CircleCI v3 rejects step output reads without JSON:API filter parameters.
function circleOutputQuery(request: IncomingMessage, response: ServerResponse) {
  const query = new URL(request.url!, 'http://circle').searchParams
  if (query.has('filter[execution]') && query.has('filter[step_num]')) return true
  json(response, { message: 'Bad Request' }, 400)
  return false
}

it('reads CircleCI workflows, steps and live output without polling subprocesses', async () => {
  const server = await http(circleHandler)
  const cli = ports()
  const circleToken = vi.fn(async () => 'circle-test-token')
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken })
  expect(await withProviderPoll(async () => {
    expect(await provider.find(run)).toBe('42')
    return provider.status(run)
  })).toEqual({ done: false, executionStarted: true, steps: [{ key: 'job:1', name: 'Tests', state: 'running' }],
    output: { key: 'job:1', text: 'failure\ndetails\n' } })
  expect(server.requests.filter(request => request.url === '/api/v2/pipeline/42')).toHaveLength(1)
  expect(cli.calls).not.toHaveBeenCalled()
  expect(circleToken).toHaveBeenCalledTimes(1)
})

it('polls CircleCI status repeatedly and collects raw Suite output through REST', async () => {
  const stdout = 'progress 1\r\u001b[2Kprogress 2\n'
  const stderr = '\u001b[31mfailure\u001b[0m\n'
  const server = await http((request, response) => {
    if (request.url === '/api/v3/jobs/job') return json(response, { data: { attributes: {
      name: 'Tests', phase: 'started', parallel_executions: [
        { steps: [{ num: 1, name: 'Suite', phase: 'started' }] },
        { steps: [{ num: 2, name: 'Suite', phase: 'started' }] },
      ],
    } } })
    if (/\/std(out|err)/.test(request.url!) && !circleOutputQuery(request, response)) return
    if (request.url!.includes('/stdout')) return response.end(stdout)
    if (request.url!.includes('/stderr')) return response.end(stderr)
    circleHandler(request, response)
  })
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  const expected = { done: false, executionStarted: true, steps: [
    { key: 'job:1', name: 'Suite', state: 'running' },
    { key: 'job:2', name: 'Suite', state: 'running' },
  ], output: { key: 'job:2', text: 'progress 2\nfailure\n' } }
  expect(await provider.find(run)).toBe('42')
  expect(await provider.status(run)).toEqual(expected)
  expect(await provider.status(run)).toEqual({ done: false, executionStarted: true, steps: expected.steps })
  expect(cli.calls).not.toHaveBeenCalled()
  expect(await provider.log(run)).toBe(`Suite\n${stdout}${stderr}\n${stdout}${stderr}`)
  expect(server.requests.some(request => request.url === '/api/v3/jobs/job/stdout?filter%5Bexecution%5D=1&filter%5Bstep_num%5D=2'))
    .toBe(true)
  expect(cli.calls).not.toHaveBeenCalled()
})

it.each([true, false])('bounds live CircleCI log reads while continuing status polling, REST: %s', async rest => {
  let now = Date.parse(finishedAt)
  let step = 1
  let ended = false
  const server = await http((request, response) => {
    if (request.url === '/api/v2/pipeline/42/workflow') return json(response, { items: [
      { id: 'workflow', status: ended ? 'success' : 'running', stopped_at: finishedAt },
    ] })
    if (request.url === '/api/v3/jobs/job') return json(response, { data: { attributes: {
      phase: 'started', parallel_executions: [{ steps: [{ num: step, name: 'Suite', phase: 'started' }] }],
    } } })
    circleHandler(request, response)
  })
  const calls = vi.fn<HostCiPorts['run']>(async (_file, args) => {
    let stdout = 'failure\ndetails\n'
    if (args[0] === 'run') stdout = JSON.stringify({ workflows: [{ phase: ended ? 'ended' : 'started',
      outcome: ended ? 'succeeded' : undefined, stopped_at: finishedAt, jobs: [{ id: 'job' }] }] })
    else if (args[1] === 'get') stdout = JSON.stringify({ phase: 'started',
      executions: [{ steps: [{ num: step, name: 'Suite', phase: 'started' }] }] })
    return { code: 0, stdout, stderr: '' }
  })
  const provider = new CircleCiProvider({ run: calls, now: () => new Date(now), cpus: 4, memoryBytes: 2 ** 30 },
    { ...server, circleToken: async () => rest ? 'fixture-token' : null })
  const outputReads = () => rest
    ? server.requests.filter(request => /\/std(out|err)/.test(request.url)).length / 2
    : calls.mock.calls.filter(([, args]) => args[0] === 'job' && args[1] === 'output').length
  const statusReads = () => rest
    ? server.requests.filter(request => request.url === '/api/v2/pipeline/42').length
    : calls.mock.calls.filter(([, args]) => args[0] === 'run').length
  expect(await provider.status(run)).toMatchObject({ done: false, output: { key: 'job:1' } })
  for (let poll = 1; poll < 15; poll++) {
    now += 4_000
    expect(await provider.status(run)).toEqual({ done: false, executionStarted: true,
      steps: [{ key: 'job:1', name: 'Suite', state: 'running' }] })
  }
  expect(outputReads()).toBe(1)
  expect(statusReads()).toBe(15)
  now += 4_000
  expect(await provider.status(run)).toMatchObject({ output: { key: 'job:1' } })
  expect(outputReads()).toBe(2)
  step = 2
  now += 4_000
  expect(await provider.status(run)).toMatchObject({ output: { key: 'job:2' } })
  expect(outputReads()).toBe(3)
  const retained = { ...run, live: { step: 'Suite', seen: [], bytes: 4 * 1024 * 1024 } }
  now += 60_000
  expect(await provider.status(retained)).toMatchObject({ done: false })
  expect(outputReads()).toBe(3)
  ended = true
  expect(await provider.status(retained)).toMatchObject({ done: true, conclusion: 'success' })
  expect(statusReads()).toBe(19)
  expect(await provider.log(retained)).toContain('failure')
  expect(outputReads()).toBe(4)
})

it('keeps the CircleCI Suite output CLI fallback when REST credentials are unavailable', async () => {
  const server = await http((_request, response) => json(response, {}, 500))
  const cli = ports()
  cli.calls.mockImplementation(async (_file, args) => {
    if (args[0] === 'run') return { code: 0, stderr: '', stdout: JSON.stringify({
      workflows: [{ jobs: [{ id: 'job' }] }],
    }) }
    if (args[1] === 'get') return { code: 0, stderr: '', stdout: JSON.stringify({
      executions: [{ steps: [{ num: 3, name: 'Suite' }] }],
    }) }
    return { code: 0, stderr: '', stdout: 'raw suite output\n' }
  })
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => null })
  expect(await provider.log(run)).toBe('Suite\nraw suite output\n')
  expect(cli.calls).toHaveBeenCalledWith('circleci', ['job', 'output', 'get', 'job',
    '--step-num', '3', '--execution', '0', '--strip-ansi=false'], { timeoutMs: 300_000 })
  expect(server.requests).toEqual([])
})

it.each([403, 429, 500])('propagates CircleCI Suite output HTTP %s errors without a CLI retry', async status => {
  const server = await http((request, response) => {
    if (request.url === '/api/v3/jobs/job') return json(response, { data: { attributes: {
      name: 'Tests', phase: 'started', parallel_executions: [
        { steps: [{ num: 1, name: 'Suite', phase: 'started' }] },
      ],
    } } })
    if (request.url!.includes('/stdout')) return json(response, { message: 'unavailable' }, status)
    circleHandler(request, response)
  })
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  await expect(provider.log(run)).rejects.toMatchObject({
    code: status === 429 ? 'CI_CLOUD_RATE_LIMITED' : 'CI_CLOUD_FAILED',
  })
  expect(cli.calls).not.toHaveBeenCalled()
})

it.each([0, CLOUD_START_TIMEOUT_MS - 1, CLOUD_START_TIMEOUT_MS, CLOUD_START_TIMEOUT_MS + 1])(
  'reports a CircleCI lookup failure independently of dispatch age at %s ms', async elapsed => {
    const server = await http((_request, response) => json(response, { message: 'Not Found' }, 404))
    const cli = ports()
    cli.value.now = () => new Date(Date.parse(run.startedAt) + elapsed)
    const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
    await expect(provider.find(run)).rejects.toMatchObject({
      code: 'CI_CLOUD_RUN_NOT_FOUND', message: 'CircleCI run is not visible.',
    })
    expect(cli.calls).not.toHaveBeenCalled()
  },
)

it.each(['\u0007', '\u001b\\'])('renders CircleCI terminal links ending with %j', async terminator => {
  const server = await http((request, response) => {
    if (request.url!.includes('/stdout')) {
      response.end('\u001b]8;;https://example.test' + terminator + 'link'
        + '\u001b]8;;' + terminator + '\t12\b3\n\u001b[31mfailure\u001b[0m\n')
      return
    }
    if (request.url!.includes('/stderr')) return response.end('')
    circleHandler(request, response)
  })
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  expect((await provider.status(run)).output).toEqual({ key: 'job:1', text: 'link    13\nfailure\n' })
  expect(cli.calls).not.toHaveBeenCalled()
})

it('preserves CircleCI configuration failures', async () => {
  const server = await http((_request, response) => json(response, { state: 'errored',
    errors: [{ type: 'config', message: 'invalid configuration' }] }))
  const provider = new CircleCiProvider(ports().value, { ...server, circleToken: async () => 'circle-test-token' })
  await expect(provider.status(run)).rejects.toMatchObject({ code: 'CI_CLOUD_PIPELINE_FAILED',
    message: 'CircleCI pipeline failed: config: invalid configuration', details: { configError: true } })
})

it('downloads only CircleCI duration artifacts from the job artifact listing', async () => {
  const server = await http((request, response) => {
    if (request.url === '/api/v3/jobs/job/artifacts') {
      return json(response, { data: [
        { attributes: { path: 'durations/durations.json', url: 'https://downloads.example/durations', execution: 0 } },
        { attributes: { path: 'logs/large.log', url: 'https://downloads.example/large', execution: 0 } },
        { attributes: { path: 'durations/test-results.json', url: 'https://downloads.example/results', execution: 0 } },
      ] })
    }
    if (request.url === '/durations') return json(response, { 'feature.test.ts': 10 })
    if (request.url === '/results') return json(response, { files: [] })
    circleHandler(request, response)
  })
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  const path = await directory()
  await writeFile(join(path, 'stale.json'), '{}')
  expect(await provider.artifacts(run, path))
    .toEqual({ durations: { 'feature.test.ts': 10 }, testResults: { files: [] },
      integrationCoverage: null, selection: null, watchdogFailure: null })
  expect(server.requests.some(request => request.url === '/large')).toBe(false)
  expect(server.requests.find(request => request.url === '/results')?.authorization).toBeUndefined()
  expect(cli.calls).not.toHaveBeenCalled()
})

it('uses the CircleCI CLI fallback when the configured token cannot be read', async () => {
  const server = await http((_request, response) => json(response, {}, 500))
  const cli = ports()
  cli.calls.mockResolvedValue({ code: 0, stdout: JSON.stringify({ workflows: [{ jobs: [{ id: 'job' }] }] }), stderr: '' })
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => null })
  expect(await provider.find(run)).toBe('42')
  expect(server.requests).toEqual([])
  expect(cli.calls).toHaveBeenCalledWith('circleci', ['run', 'get', '42', '--json'], { timeoutMs: 15_000 })
})

it.each(['success', 'failed', 'canceled'])(
  'preserves terminal CircleCI %s states and finish times when job details are unavailable', async status => {
    const server = await http((request, response) => {
      if (request.url === '/api/v2/pipeline/42/workflow') return json(response,
        { items: [{ id: 'workflow', status, stopped_at: finishedAt }] })
      if (request.url === '/api/v3/jobs/job') return json(response, { message: 'Job unavailable' }, 500)
      circleHandler(request, response)
    })
    const cli = ports()
    const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
    const conclusions: Record<string, string> = { success: 'success', failed: 'failure', canceled: 'cancelled' }
    const conclusion = conclusions[status]
    expect(await provider.status(run)).toEqual({ done: true, conclusion, finishedAt, steps: [],
      ...(conclusion === 'success' ? { executionStarted: true } : {}) })
    expect(server.requests.filter(request => request.url === '/api/v3/jobs/job')).toHaveLength(1)
    expect(cli.calls).not.toHaveBeenCalled()
  },
)

it.each(['success', 'failed', 'canceled'])(
  'retains terminal CircleCI %s outcomes and finish times when child job details lag', async status => {
    const server = await http((request, response) => {
      if (request.url === '/api/v2/pipeline/42/workflow') return json(response,
        { items: [{ id: 'workflow', status, stopped_at: finishedAt }] })
      if (request.url === '/api/v3/jobs/job') return json(response, { data: { attributes: {
        name: 'Tests', phase: 'started', ended_at: '2026-10-01T00:02:00Z',
        parallel_executions: [{ steps: [
          { num: 1, name: 'Checkout', phase: 'ended', outcome: 'succeeded' },
          { num: 2, name: 'Suite', phase: 'started' },
        ] }],
      } } })
      circleHandler(request, response)
    })
    const cli = ports()
    const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
    const conclusions: Record<string, string> = { success: 'success', failed: 'failure', canceled: 'cancelled' }
    expect(await provider.status(run)).toEqual({
      done: true, executionStarted: true, conclusion: conclusions[status], finishedAt,
      steps: [
        { key: 'job:1', name: 'Checkout', state: 'passed' },
        { key: 'job:2', name: 'Suite', state: 'running' },
      ],
    })
    expect(server.requests.filter(request => request.url === '/api/v3/jobs/job')).toHaveLength(1)
    expect(server.requests.some(request => request.url!.includes('/stdout'))).toBe(false)
    expect(cli.calls).not.toHaveBeenCalled()
  },
)

it.each([
  { outcome: 'succeeded', state: 'passed' },
  { outcome: 'failed', state: 'failed' },
  { outcome: 'canceled', state: 'failed' },
  { outcome: 'skipped', state: 'skipped' },
])('reports completed CircleCI steps as $state while the workflow is running', async ({ outcome, state }) => {
  const server = await http((request, response) => {
    if (request.url === '/api/v3/jobs/job') return json(response, { data: { attributes: {
      name: 'Tests', phase: 'ended', outcome, ended_at: finishedAt,
      parallel_executions: [{ steps: [{ num: 1, name: 'Tests', phase: 'ended', outcome }] }],
    } } })
    circleHandler(request, response)
  })
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  expect(await provider.status(run)).toEqual({ done: false, steps: [{ key: 'job:1', name: 'Tests', state }],
    ...(['succeeded', 'failed'].includes(outcome) ? { executionStarted: true } : {}) })
  expect(cli.calls).not.toHaveBeenCalled()
})

it.each([401, 403])('classifies CircleCI HTTP %s lookup denials and still attempts cancellation', async status => {
  const server = await http((_request, response) => json(response, { message: 'circle-test-token denied' }, status))
  const cli = ports()
  cli.calls.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  await expect(provider.find(run)).rejects.toMatchObject({
    code: 'CI_CLOUD_RUN_UNREADABLE', message: expect.stringContaining('[redacted] denied'),
  })
  await expect(provider.cancel(run)).resolves.toBeUndefined()
  expect(cli.calls).toHaveBeenCalledExactlyOnceWith('circleci', ['run', 'cancel', '42', '--force'],
    { timeoutMs: 15_000 })
})

it('keeps CircleCI rate limits from triggering cancellation', async () => {
  const server = await http((_request, response) => json(response, { message: 'rate limit' }, 429))
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  await expect(provider.cancel(run)).rejects.toMatchObject({ code: 'CI_CLOUD_RATE_LIMITED' })
  expect(cli.calls).not.toHaveBeenCalled()
})

it('propagates CircleCI cancellation denials after an unreadable lookup', async () => {
  const server = await http((_request, response) => json(response, { message: 'Forbidden' }, 403))
  const cli = ports()
  cli.calls.mockResolvedValue({ code: 1, stdout: '', stderr: 'permission denied' })
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  await expect(provider.cancel(run)).rejects.toMatchObject({
    code: 'CI_CLOUD_FAILED', message: 'CircleCI did not accept circleci run cancel: permission denied',
  })
  expect(cli.calls).toHaveBeenCalledExactlyOnceWith('circleci', ['run', 'cancel', '42', '--force'],
    { timeoutMs: 15_000 })
})

it('keeps full CircleCI log output, empty streams, progress redraws and report labels', async () => {
  const server = await http((request, response) => {
    if (request.url === '/api/v3/jobs/job') return json(response, { data: { attributes: {
      name: 'Tests', phase: 'ended', outcome: 'failed', parallel_executions: [{ steps: [
        { num: 1, name: 'Tests', phase: 'ended', outcome: 'failed', started_at: '2026-10-01T00:00:00Z',
          ended_at: finishedAt, exit_code: 1, command: 'test' },
        { num: 2, name: 'Cleanup', phase: 'ended', outcome: 'succeeded' },
      ] }],
    } } })
    if (new URL(request.url!, 'http://fixture').searchParams.get('filter[step_num]') === '2') {
      return json(response, { message: 'Not Found' }, 404)
    }
    if (request.url!.includes('/stdout')) {
      response.end('progress 1\r\u001b[2Kprogress 2\n' + 'line\n'.repeat(250) + 'failure\n')
      return
    }
    if (request.url!.includes('/stderr')) return response.end('')
    circleHandler(request, response)
  })
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, { ...server, circleToken: async () => 'circle-test-token' })
  expect(await provider.log(run)).toBe('# Job Output\n- ID: `job`\n- Name: Tests\n- Execution: 0\n'
    + '\n## 1: Tests\n- Status: ❌ failed\n- Duration: 1m0s\n- Exit Code: 1\n- Command: `test`\n### Output\n'
    + '\n```text\nprogress 2\n' + 'line\n'.repeat(250) + 'failure\n```\n'
    + '\n## 2: Cleanup\n- Status: ✅ succeeded\n- Duration: -\n### Output\n\n_(no output)_\n')
  expect(cli.calls).not.toHaveBeenCalled()
})

it.each([false, true])('keeps best-effort CircleCI live output while propagating rate limits: %s', async limited => {
  const server = await http((request, response) => {
    if (request.url!.includes('/stdout')) return json(response, { message: limited ? 'rate limit' : 'unavailable' }, limited ? 429 : 500)
    circleHandler(request, response)
  })
  const provider = new CircleCiProvider(ports().value, { ...server, circleToken: async () => 'circle-test-token' })
  if (limited) {
    await expect(provider.status(run)).rejects.toMatchObject({ code: 'CI_CLOUD_RATE_LIMITED',
      message: 'CircleCI rate limit reached; polling paused.' })
  } else {
    expect(await provider.status(run)).toEqual({ done: false, executionStarted: true, steps: [{ key: 'job:1', name: 'Tests', state: 'running' }] })
  }
})

it('does not expose credentials echoed in HTTP errors', async () => {
  const server = await http((_request, response) => json(response, { message: 'failure for test-token' }, 500))
  const provider = new GitHubActionsProvider(ports().value, server)
  await expect(provider.status(run)).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED',
    message: "GitHub Actions did not return the run's jobs: gh: failure for [redacted] (HTTP 500)" })
})

it('preserves GitHub artifact failure messages for corrupt archives', async () => {
  const server = await http((request, response) => {
    if (request.url!.endsWith('/zip')) return response.end('corrupt archive')
    json(response, { artifacts: [{ id: 7, name: 'durations', expired: false }] })
  })
  const provider = new GitHubActionsProvider(ports().value, server)
  await expect(provider.artifacts(run, await directory())).rejects.toMatchObject({
    code: 'CI_CLOUD_FAILED', message: 'GitHub Actions artifacts could not be downloaded.',
  })
})

it('reads the CircleCI CLI configured token and keeps it in memory between polls', async () => {
  const root = await directory()
  await mkdir(join(root, 'circleci'))
  await writeFile(join(root, 'circleci', 'config.yml'), 'token: configured-test-token\n')
  vi.stubEnv('XDG_CONFIG_HOME', root)
  vi.stubEnv('CIRCLE_TOKEN', '')
  vi.stubEnv('CIRCLE_CLI_TOKEN', '')
  cleanups.push(async () => { vi.unstubAllEnvs() })
  const server = await http(circleHandler)
  const cli = ports()
  const provider = new CircleCiProvider(cli.value, server)
  expect(await provider.find(run)).toBe('42')
  await rm(join(root, 'circleci', 'config.yml'))
  expect(await provider.find(run)).toBe('42')
  expect(server.requests.every(request => request.authorization === 'Bearer configured-test-token')).toBe(true)
  expect(cli.calls).toHaveBeenCalledExactlyOnceWith('secret-tool',
    ['lookup', 'service', 'com.circleci.cli:https://circleci.com', 'username', expect.any(String)],
    { timeoutMs: 15_000 })
})
