import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GitHubActionsProvider, type CloudRun } from './cloudProviders.js'
import { fixture } from './cloud.testSupport.js'
import { readCloudRun } from './cloudJournal.js'
import type { HostCiPorts } from './runner.js'

afterEach(() => vi.restoreAllMocks())

const run: CloudRun = { runId: 'ticket', repository: 'octo/site', mirror: 'octo/site-ci', commit: 'abc',
  suite: 'lint', startedAt: '2026-10-01T00:00:00Z', providerRunId: null, state: 'starting',
  finishedAt: null, exitCode: null, message: null }

function cliFixture(options: { repeatPage?: boolean; missingTotal?: boolean; total?: number } = {}) {
  const requests: URL[] = []
  const runs = Array.from({ length: 201 }, (_, index) => ({ id: index + 100,
    display_title: index === 200 ? 'ci ticket' : 'other', status: 'queued', head_sha: 'abc' }))
  const page = (number: number) => {
    const index = options.repeatPage && number === 2 ? 0 : number - 1
    return runs.slice(index * 100, index * 100 + 100)
  }
  const legacy = [1, 2, 3].flatMap(page).map(value => ({ databaseId: value.id,
    displayTitle: value.display_title, status: value.status, headSha: value.head_sha }))
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(run.startedAt),
    run: vi.fn(async (_file, args) => {
      if (args[0] === 'auth') return { code: 1, stdout: '', stderr: 'REST token unavailable' }
      if (args[0] === 'run' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(legacy), stderr: '' }
      if (args[0] === 'api') {
        const url = new URL(args[1]!, 'https://api.github.com')
        requests.push(url)
        return { code: 0, stdout: JSON.stringify({ workflow_runs: page(Number(url.searchParams.get('page'))),
          ...options.missingTotal ? {} : { total_count: options.total ?? runs.length } }), stderr: '' }
      }
      throw new Error('Unexpected provider command')
    }) }
  return { provider: new GitHubActionsProvider(ports), requests, ports }
}

it('rejects duplicate CLI page IDs even when the aggregate has fewer than 1000 entries', async () => {
  const f = cliFixture({ repeatPage: true })
  await expect(f.provider.discover(run)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
})

it.each([{ missingTotal: true }, { total: 202 }])('retains ownership when CLI inventory totals cannot prove completeness: %j', async options => {
  const f = cliFixture(options)
  await expect(f.provider.discover(run)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
})

it('discovers queued attempts through complete CLI pages when REST credentials are unavailable', async () => {
  const f = cliFixture()
  expect(await f.provider.discover(run)).toEqual(['300'])
  expect(f.requests.map(url => url.searchParams.get('page'))).toEqual(['1', '2', '3'])
  expect(vi.mocked(f.ports.run).mock.calls.some(([, args]) => args[0] === 'run' && args[1] === 'list')).toBe(false)
})

it('keeps an uncertain submission owned after its cancellation window when CLI discovery repeats IDs', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const original = f.ports.run
  let repeated = false
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'gh' && args[0] === 'workflow') {
      await original(file, args, options)
      return { code: 1, stdout: '', stderr: 'connection closed while sending dispatch' }
    }
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/actions/workflows/ci.yml/runs?')) {
      const value = { id: 91, display_title: 'ci another-ticket', status: 'queued', head_sha: f.commit }
      return { code: 0, stdout: JSON.stringify({ total_count: repeated ? 2 : 0,
        workflow_runs: repeated ? [value, value] : [] }), stderr: '' }
    }
    return original(file, args, options)
  })
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
  const cancel = { operation: 'cancel', runId } as const
  expect(await f.cloud.handle(cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  repeated = true
  f.github.listed = Array.from({ length: 2 }, () => ({ databaseId: 91,
    displayTitle: 'ci another-ticket', headSha: f.commit }))
  f.advance(75_001)
  await expect(f.reopen().handle(cancel)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
  const saved = await readCloudRun(join(f.root, 'ci-cloud', 'runs', runId, 'meta.json'))
  expect(saved).toMatchObject({ state: 'starting', dispatch: { uncertain: true } })
  expect(saved.cancellation?.completedAt).toBeUndefined()
  repeated = false
  f.github.listed = []
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'canceled' } })
})
