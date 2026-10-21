import { expect, it, vi } from 'vitest'
import { GitHubActionsProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

const run: CloudRun = {
  runId: 'ticket', repository: 'octo/site', mirror: 'octo/site-ci', commit: 'abc', suite: 'lint',
  startedAt: '2026-10-01T00:00:00Z', providerRunId: '42', state: 'running',
  finishedAt: null, exitCode: null, message: null,
  dispatch: { attempts: 1, at: '2026-10-01T00:00:00Z', input: {
    mirror: 'octo/site-ci', branch: 'ci/source', workflowRef: 'ci/snapshot',
    runId: 'ticket', suite: 'lint', slice: '',
  } },
}

function discoveryFixture(count: number, options: { target?: boolean; repeatPage?: boolean } = {}) {
  const requests: URL[] = []
  const listed = Array.from({ length: count }, (_, index) => ({ id: index + 100,
    display_title: options.target && index === count - 1 ? 'ci ticket' : 'other',
    status: 'completed', head_sha: 'abc' }))
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(run.startedAt),
    run: vi.fn(async () => ({ code: 0, stdout: 'test-token', stderr: '' })) }
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input))
    requests.push(url)
    const page = Number(url.searchParams.get('page'))
    const offset = options.repeatPage && page === 2 ? 0 : (page - 1) * 100
    return new Response(JSON.stringify({ total_count: count, workflow_runs: listed.slice(offset, offset + 100) }))
  }
  return { provider: new GitHubActionsProvider(ports, { fetch }), requests, listed }
}

it('discovers an attempt beyond two full GitHub pages with successive page cursors', async () => {
  const f = discoveryFixture(201, { target: true })
  expect(await f.provider.discover(run)).toEqual([String(f.listed.at(-1)!.id)])
  expect(f.requests.map(url => url.searchParams.get('page'))).toEqual(['1', '2', '3'])
  expect(f.requests.every(url => url.searchParams.get('branch') === 'ci/snapshot'
    && url.searchParams.get('event') === 'workflow_dispatch' && url.searchParams.get('per_page') === '100')).toBe(true)
})

it('confirms an absent attempt after the empty page following 200 GitHub runs', async () => {
  const f = discoveryFixture(200)
  expect(await f.provider.discover(run)).toEqual([])
  expect(f.requests.map(url => url.searchParams.get('page'))).toEqual(['1', '2', '3'])
})

it('retains ownership at the GitHub search ceiling instead of treating a capped listing as complete', async () => {
  const f = discoveryFixture(1000)
  await expect(f.provider.discover(run)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
  expect(f.requests.map(url => url.searchParams.get('page')))
    .toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
})

it('does not confirm completeness when moving pages repeat entries and omit part of the inventory', async () => {
  const f = discoveryFixture(201, { repeatPage: true })
  await expect(f.provider.discover(run)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
})
