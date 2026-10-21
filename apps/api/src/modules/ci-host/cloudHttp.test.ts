import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudCi } from './cloud.js'
import { GitHubActionsProvider, type CloudRun } from './cloudProviders.js'
import { readCloudRun, saveCloudRun } from './cloudJournal.js'
import { CloudHttp } from './cloudHttp.js'
import { systemHostCiPorts } from './runner.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

it('reports a CLI credential fallback and retries token acquisition after a bounded interval', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'private credential detail' })
    .mockResolvedValue({ code: 0, stdout: 'fixture-token', stderr: '' })
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  const http = new CloudHttp({ ...systemHostCiPorts(), run }, 'github', { fetch })
  expect(await http.request('/fixture')).toBeNull()
  expect(http).toMatchObject({ transport: { source: 'cli', fallbackCount: 1,
    lastError: 'GitHub Actions REST credential resolution failed.', reason: expect.any(String) } })
  expect(JSON.stringify(http.transport)).not.toContain('private credential detail')
  expect(await http.request('/fixture')).toBeNull()
  expect(run).toHaveBeenCalledTimes(1)
  expect(http.transport).toMatchObject({ fallbackCount: 2 })
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(http.request('/fixture')).resolves.toBeInstanceOf(Response)
  expect(run).toHaveBeenCalledTimes(2)
  expect(http.transport).toMatchObject({ source: 'rest', fallbackCount: 2, lastError: null, reason: null })
})

it('makes unavailable REST credentials visible without fetching over REST', async () => {
  const fetch = vi.fn()
  const http = new CloudHttp(systemHostCiPorts(), 'circleci', { circleToken: async () => null, fetch })
  expect(await http.request('/fixture')).toBeNull()
  expect(http.transport).toMatchObject({ source: 'cli', fallbackCount: 1,
    lastError: 'CircleCI REST credential resolution failed.',
    reason: 'CircleCI REST credential resolution failed.' })
  expect(fetch).not.toHaveBeenCalled()
})

it('fails malformed configured CircleCI credentials without substituting CLI resolution', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'cloud-credentials-'))
  try {
    vi.stubEnv('CIRCLE_TOKEN', '')
    vi.stubEnv('CIRCLE_CLI_TOKEN', '')
    vi.stubEnv('XDG_CONFIG_HOME', root)
    await mkdir(join(root, 'circleci'))
    await writeFile(join(root, 'circleci', 'config.yml'), 'token: [invalid')
    const http = new CloudHttp(systemHostCiPorts(), 'circleci')
    await expect(http.request('/fixture')).rejects.toMatchObject({ code: 'CI_CLOUD_CREDENTIALS_UNAVAILABLE',
      message: 'CircleCI credential configuration could not be read.' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('exposes failed credential refresh without retaining a null token forever', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockResolvedValueOnce({ code: 0, stdout: 'expired-token', stderr: '' })
    .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'private detail' })
    .mockResolvedValue({ code: 0, stdout: 'fresh-token', stderr: '' })
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockResolvedValue(new Response('{}'))
  const http = new CloudHttp({ ...systemHostCiPorts(), run }, 'github', { fetch })
  expect(await http.request('/fixture')).toBeNull()
  expect(http).toMatchObject({ transport: { source: 'cli', fallbackCount: 1, lastError: expect.any(String) } })
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(http.request('/fixture')).resolves.toBeInstanceOf(Response)
  expect(run).toHaveBeenCalledTimes(3)
})


it('keeps provider CLI degradation visible in the cloud reply and persisted run', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'cloud-transport-'))
  try {
    const ports = { ...systemHostCiPorts(), run: vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'auth') return { code: 1, stdout: '', stderr: 'private credential details' }
      if (args[0] === 'api') return { code: 0, stderr: '', stdout: 'HTTP/1.1 200 OK\r\n\r\n'
        + JSON.stringify({ jobs: [{ id: 1, status: 'in_progress', steps: [
          { number: 1, name: 'Suite', status: 'in_progress', conclusion: null },
        ] }] }) }
      throw new Error('Unexpected provider operation')
    }) }
    const provider = new GitHubActionsProvider(ports)
    const run: CloudRun = { runId: '11111111-1111-4111-8111-111111111111',
      repository: 'fixture/project', mirror: 'fixture/ci', commit: 'a'.repeat(40), suite: 'lint',
      startedAt: '2026-10-14T00:00:00.000Z', providerRunId: '42', state: 'running',
      finishedAt: null, exitCode: null, message: null, workflowStarted: true }
    const path = join(root, 'runs', run.runId, 'meta.json')
    await saveCloudRun(path, run)
    const cloud = new CloudCi('main', provider, async () => null, root, ports)
    const reply = await cloud.handle({ operation: 'read', runId: run.runId, afterOffset: 0, maxBytes: 1024 })
    expect(reply).toMatchObject({ operation: 'read', run: {
      transport: { source: 'cli', fallbackCount: 1, lastError: expect.any(String) },
      message: expect.stringContaining('CLI transport:'),
    } })
    expect(await readCloudRun(path)).toMatchObject({ transport: { source: 'cli', fallbackCount: 1 } })
    expect(JSON.stringify(reply)).not.toContain('private credential')
  } finally { await rm(root, { recursive: true, force: true }) }
})
