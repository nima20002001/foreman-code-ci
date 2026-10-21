import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CloudHttp } from './cloudHttp.js'
import { CloudCi } from './cloud.js'
import { CircleCiProvider } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

const fixture = vi.hoisted(() => ({ home: '', warn: vi.fn(), info: vi.fn() }))
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fixture.home || actual.homedir(),
    userInfo: () => ({ uid: 1000, gid: 1000, username: 'fixture-account', homedir: fixture.home, shell: null }) }
})
vi.mock('../diagnostics/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../diagnostics/logger.js')>()
  return { ...actual, componentLogger: (component: Parameters<typeof actual.componentLogger>[0]) => {
    const logger = actual.componentLogger(component)
    logger.warn = fixture.warn
    logger.info = fixture.info
    return logger
  } }
})

let root: string
beforeEach(async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  root = await mkdtemp(join(parent, 'circle-credentials-'))
  fixture.home = root
  fixture.warn.mockClear()
  fixture.info.mockClear()
  vi.stubEnv('CIRCLE_TOKEN', '')
  vi.stubEnv('CIRCLE_CLI_TOKEN', '')
  vi.stubEnv('CIRCLE_HOST', '')
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'))
  await mkdir(join(root, 'config', 'circleci'), { recursive: true })
  await writeFile(join(root, 'config', 'circleci', 'config.yml'),
    'host: https://circleci.com\ndevice_id: fixture-device\nuser_id: fixture-user\ntelemetry: false\n')
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fixture.home = ''
  await rm(root, { recursive: true, force: true })
})

function ports(run: HostCiPorts['run']): HostCiPorts {
  return { run, now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30 }
}

it('uses the logged-in CLI keyring credential for REST and shares it between clients', async () => {
  const run = vi.fn<HostCiPorts['run']>().mockResolvedValue({ code: 0, stdout: 'fixture-keyring-token\n', stderr: '' })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'))
  const shared = ports(run)
  const first = new CloudHttp(shared, 'circleci', { fetch })
  const second = new CloudHttp(shared, 'circleci', { fetch })
  const replies = await Promise.all([first.request('/api/v2/me'), second.request('/api/v2/me')])
  expect(replies.every(reply => reply instanceof Response)).toBe(true)
  expect(run).toHaveBeenCalledExactlyOnceWith('secret-tool',
    ['lookup', 'service', 'com.circleci.cli:https://circleci.com', 'username', 'fixture-account'],
    { timeoutMs: 15_000 })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls.every(([, init]) =>
    new Headers(init?.headers).get('authorization') === 'Bearer fixture-keyring-token')).toBe(true)
  expect(first.transport).toEqual({ source: 'rest', reason: null, lastError: null, fallbackCount: 0 })
  expect(fixture.warn).not.toHaveBeenCalled()
  expect(JSON.stringify([fixture.info.mock.calls, first.transport])).not.toContain('fixture-keyring-token')
})

it('re-resolves a rejected keyring credential once for concurrent 401 responses', async () => {
  const run = vi.fn<HostCiPorts['run']>()
    .mockResolvedValueOnce({ code: 0, stdout: 'fixture-expired', stderr: '' })
    .mockResolvedValue({ code: 0, stdout: 'fixture-refreshed', stderr: '' })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) =>
    new Response('{}', { status: new Headers(init?.headers).get('authorization') === 'Bearer fixture-expired'
      ? 401 : 200 }))
  const shared = ports(run)
  const first = new CloudHttp(shared, 'circleci', { fetch })
  const second = new CloudHttp(shared, 'circleci', { fetch })
  const replies = await Promise.all([first.request('/api/v2/me'), second.request('/api/v2/me')])
  expect(replies.map(reply => reply?.status)).toEqual([200, 200])
  expect(run).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(4)
  await expect(first.request('/api/v2/me')).resolves.toHaveProperty('status', 200)
  expect(run).toHaveBeenCalledTimes(2)
})

it('prefers the keyring credential over a stale plaintext CLI token', async () => {
  await writeFile(join(root, 'config', 'circleci', 'config.yml'), 'token: fixture-stale\n')
  const run = vi.fn<HostCiPorts['run']>().mockResolvedValue({ code: 0, stdout: 'fixture-keyring', stderr: '' })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'))
  await expect(new CloudHttp(ports(run), 'circleci', { fetch }).request('/api/v2/me'))
    .resolves.toBeInstanceOf(Response)
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fixture-keyring')
})

it('retains plaintext credentials when the keyring is unavailable', async () => {
  await writeFile(join(root, 'config', 'circleci', 'config.yml'), 'token: fixture-plaintext\n')
  const run = vi.fn<HostCiPorts['run']>().mockResolvedValue({ code: 1, stdout: '', stderr: 'fixture-store-error' })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'))
  await expect(new CloudHttp(ports(run), 'circleci', { fetch }).request('/api/v2/me'))
    .resolves.toBeInstanceOf(Response)
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fixture-plaintext')
})

it('keeps explicit environment credentials ahead of the CLI stores', async () => {
  vi.stubEnv('CIRCLE_TOKEN', 'fixture-environment')
  const run = vi.fn<HostCiPorts['run']>()
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'))
  await expect(new CloudHttp(ports(run), 'circleci', { fetch }).request('/api/v2/me'))
    .resolves.toBeInstanceOf(Response)
  expect(run).not.toHaveBeenCalled()
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fixture-environment')
})

it('reports missing REST credentials in provider readiness even with a working CLI login', async () => {
  const run = vi.fn<HostCiPorts['run']>(async file => file === 'circleci'
    ? { code: 0, stdout: '{}', stderr: '' }
    : { code: 1, stdout: '', stderr: 'fixture-private-store-detail' })
  const shared = ports(run)
  const provider = new CircleCiProvider(shared, { fetch: vi.fn() })
  const cloud = new CloudCi('fixture-main', provider, async () => null, root, shared)
  const first = await cloud.handle({ operation: 'status' })
  const second = await cloud.handle({ operation: 'status' })
  expect(first).toMatchObject({ operation: 'status', ready: true,
    reasons: [expect.stringContaining('CLI transport: CircleCI REST credential resolution failed.')] })
  expect(second).toEqual(first)
  expect(provider.transport).toMatchObject({ source: 'cli', lastError: 'CircleCI REST credential resolution failed.' })
  expect(fixture.warn).toHaveBeenCalledTimes(1)
  expect(JSON.stringify([first, provider.transport, fixture.warn.mock.calls]))
    .not.toContain('fixture-private-store-detail')
  await cloud.reconcile()
})

it('counts each CLI fallback but logs only transitions, including a later degradation', async () => {
  vi.useFakeTimers()
  const circleToken = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('fixture-token')
    .mockResolvedValue(null)
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'))
  const http = new CloudHttp(ports(vi.fn()), 'circleci', { circleToken, fetch })
  for (let request = 0; request < 4; request++) expect(await http.request('/api/v2/me')).toBeNull()
  expect(fixture.warn).toHaveBeenCalledTimes(1)
  expect(http.transport).toMatchObject({ source: 'cli', fallbackCount: 4,
    lastError: 'CircleCI REST credential resolution failed.' })
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(http.request('/api/v2/me')).resolves.toHaveProperty('status', 200)
  fetch.mockImplementationOnce(async () => new Response('{}', { status: 401 }))
  expect(await http.request('/api/v2/me')).toBeNull()
  expect(await http.request('/api/v2/me')).toBeNull()
  expect(http.transport).toMatchObject({ source: 'cli', fallbackCount: 6 })
  expect(fixture.warn).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain('fixture-token')
})

it('isolates tokens and concurrent 401 refresh by login even when clients share ports', async () => {
  const primaryToken = vi.fn().mockResolvedValueOnce('fixture-primary-old').mockResolvedValue('fixture-primary-new')
  const reserveToken = vi.fn().mockResolvedValueOnce('fixture-reserve-old').mockResolvedValue('fixture-reserve-new')
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    const token = new Headers(init?.headers).get('authorization') ?? ''
    return new Response('{}', { status: token.endsWith('-old') ? 401 : 200 })
  })
  const shared = ports(vi.fn())
  const primary = new CloudHttp(shared, 'circleci', { fetch, circleAccountId: 'default', circleToken: primaryToken })
  const reserve = new CloudHttp(shared, 'circleci', { fetch, circleAccountId: 'reserve', circleToken: reserveToken })
  expect((await Promise.all([primary.request('/api/v2/me'), reserve.request('/api/v2/me')]))
    .map(response => response?.status)).toEqual([200, 200])
  expect(primaryToken).toHaveBeenCalledTimes(2)
  expect(reserveToken).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
    .toEqual(expect.arrayContaining(['Bearer fixture-primary-old', 'Bearer fixture-primary-new',
      'Bearer fixture-reserve-old', 'Bearer fixture-reserve-new']))
  reserve.invalidate()
  await primary.request('/api/v2/me')
  expect(primaryToken).toHaveBeenCalledTimes(2)
})
it('redacts both rejected and refreshed tokens and sends no credentials to signed downloads', async () => {
  const circleToken = vi.fn().mockResolvedValueOnce('fixture-old-canary').mockResolvedValue('fixture-new-canary')
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'fixture-old-canary fixture-new-canary' }), { status: 403 }))
    .mockResolvedValueOnce(new Response('artifact'))
  const http = new CloudHttp(ports(vi.fn()), 'circleci', { fetch, circleAccountId: 'reserve', circleToken })
  const response = (await http.request('/api/v2/me'))!
  const error = await http.check(response, detail => detail).catch(error => error)
  expect(error.message).not.toContain('fixture-old-canary')
  expect(error.message).not.toContain('fixture-new-canary')
  expect(await http.downloadUrl('https://fixture.invalid/signed', 15000)).toEqual(Buffer.from('artifact'))
  expect(fetch.mock.calls[2]?.[1]?.headers).toBeUndefined()
  expect(JSON.stringify([fixture.warn.mock.calls, fixture.info.mock.calls, http.transport]))
    .not.toContain('canary')
})

it('shares same-login loads and retries rejected resolution without disturbing another login', async () => {
  const shared = ports(vi.fn())
  const primaryToken = vi.fn().mockRejectedValueOnce(new Error('fixture-secret-path'))
    .mockResolvedValue('fixture-primary')
  const reserveToken = vi.fn().mockResolvedValue('fixture-reserve')
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'))
  const first = new CloudHttp(shared, 'circleci', { fetch, circleAccountId: 'default', circleToken: primaryToken })
  const second = new CloudHttp(shared, 'circleci', { fetch, circleAccountId: 'default', circleToken: primaryToken })
  const reserve = new CloudHttp(shared, 'circleci', { fetch, circleAccountId: 'reserve', circleToken: reserveToken })
  const failure = await first.available().catch(error => error)
  expect(failure).toMatchObject({ code: 'CI_CLOUD_CREDENTIALS_UNAVAILABLE' })
  expect(failure.cause).toBeUndefined()
  expect(await reserve.available()).toBe(true)
  expect(await Promise.all([first.available(), second.available()])).toEqual([true, true])
  expect(primaryToken).toHaveBeenCalledTimes(2)
  expect(reserveToken).toHaveBeenCalledTimes(1)
  first.invalidate()
  expect(await reserve.available()).toBe(true)
  expect(reserveToken).toHaveBeenCalledTimes(1)
})
