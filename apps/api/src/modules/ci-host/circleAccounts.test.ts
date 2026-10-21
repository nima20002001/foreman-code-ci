import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_CIRCLE_ACCOUNTS, type CircleAccount } from '@foreman-code/contracts/management'
import { CircleAccountDirectory } from './circleAccounts.js'
import type { HostCiPorts } from './runner.js'

let root: string
const reserve: CircleAccount = { id: 'reserve', label: 'Reserve', role: 'standby',
  organizations: ['fixture-delta', 'fixture-echo', 'fixture-foxtrot'] }
beforeEach(async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  root = await mkdtemp(join(parent, 'circle-accounts-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function profile(id: string, contents: string) {
  const xdg = join(root, 'foreman-code', 'circleci-accounts', id)
  await mkdir(join(xdg, 'circleci'), { recursive: true, mode: 0o700 })
  await writeFile(join(xdg, 'circleci', 'config.yml'), contents, { mode: 0o600 })
  return xdg
}
function fixture(environment: NodeJS.ProcessEnv = {}) {
  const run = vi.fn<HostCiPorts['run']>().mockResolvedValue({ code: 0, stdout: '{}', stderr: '' })
  const ports: HostCiPorts = { run, now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30 }
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'))
  const directory = new CircleAccountDirectory(ports,
    { list: async () => [...DEFAULT_CIRCLE_ACCOUNTS.accounts, reserve] }, { configRoot: root, environment, fetch })
  return { directory, run, fetch }
}
it('binds both transports to private profiles with complete immutable child environments', async () => {
  const primaryXdg = await profile('default', 'token: fixture-primary\nhost: https://circleci.com\n')
  const reserveXdg = await profile('reserve', 'token: fixture-reserve\nhost: https://circleci.com\n')
  const environment = { PATH: '/fixture/bin', LANG: 'C.UTF-8', CIRCLE_TOKEN: 'fixture-ambient',
    CIRCLE_CLI_TOKEN: 'fixture-other-ambient', CIRCLE_HOST: 'https://fixture.invalid' }
  const f = fixture(environment)
  const primary = (await f.directory.context('default'))!
  const standby = (await f.directory.context('reserve'))!
  for (const context of [primary, standby]) {
    await context.ports.run('circleci', ['auth', 'me'], { timeoutMs: 15000 })
    await context.http.request('/api/v2/me')
  }
  expect(f.run.mock.calls.map(([, , options]) => options?.env)).toEqual([
    { ...environment, XDG_CONFIG_HOME: primaryXdg, CIRCLE_TOKEN: 'fixture-primary',
      CIRCLE_CLI_TOKEN: 'fixture-primary', CIRCLE_HOST: 'https://circleci.com' },
    { ...environment, XDG_CONFIG_HOME: reserveXdg, CIRCLE_TOKEN: 'fixture-reserve',
      CIRCLE_CLI_TOKEN: 'fixture-reserve', CIRCLE_HOST: 'https://circleci.com' },
  ])
  expect(f.run.mock.calls.every(([, argv]) => argv.join(' ').includes('fixture-primary') === false)).toBe(true)
  expect(f.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
    .toEqual(['Bearer fixture-primary', 'Bearer fixture-reserve'])
  const issued = f.run.mock.calls[1]![2]!.env!
  await profile('reserve', 'token: fixture-rotated\n')
  standby.invalidate()
  await standby.ports.run('circleci', ['auth', 'me'])
  expect(issued.CIRCLE_TOKEN).toBe('fixture-reserve')
  expect(f.run.mock.calls.at(-1)?.[2]?.env?.CIRCLE_TOKEN).toBe('fixture-rotated')
  expect(environment.CIRCLE_TOKEN).toBe('fixture-ambient')
})
it('uses existing primary precedence and never consults ambient or keyring for a missing standby profile', async () => {
  const f = fixture({ PATH: '/fixture/bin', CIRCLE_TOKEN: 'fixture-primary-env' })
  const primary = (await f.directory.context('default'))!
  await primary.ports.run('circleci', ['auth', 'me'])
  expect(f.run.mock.calls[0]?.[2]?.env?.CIRCLE_TOKEN).toBe('fixture-primary-env')
  const standby = (await f.directory.context('reserve'))!
  expect(await standby.tokenConfigured()).toBe(false)
  await expect(standby.ports.run('circleci', ['auth', 'me'])).rejects.toMatchObject({
    code: 'CI_CLOUD_CREDENTIALS_UNAVAILABLE',
  })
  expect(f.run).toHaveBeenCalledTimes(1)
  expect(await f.directory.read(reserve)).toMatchObject({ tokenConfigured: false, ready: false })
})
it('sanitizes malformed profile errors without exposing profile paths or token content', async () => {
  await profile('reserve', 'token: [fixture-secret\n')
  const f = fixture({ CIRCLE_TOKEN: 'fixture-ambient' })
  const standby = (await f.directory.context('reserve'))!
  const error = await standby.http.request('/api/v2/me').catch(error => error)
  expect(error).toMatchObject({ code: 'CI_CLOUD_CREDENTIALS_UNAVAILABLE' })
  expect(String(error)).not.toContain('fixture-secret')
  expect(String(error)).not.toContain(root)
  expect(error.cause).toBeUndefined()
  expect(await f.directory.read(reserve)).toEqual({ tokenConfigured: false, ready: false,
    reasons: ['CircleCI credential configuration could not be read.'], orgs: expect.any(Array) })
  expect(f.run).not.toHaveBeenCalled()
})
