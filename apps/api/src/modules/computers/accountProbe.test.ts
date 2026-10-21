import { mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { probeComputerAccounts, systemPorts, type AccountProbePorts } from './accountProbe.js'

const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function cachedProbeFixture() {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'account-probe-'))
  directories.push(directory)
  const binary = join(directory, 'claude')
  await writeFile(binary, 'original', { mode: 0o700 })
  const environment = { HOME: directory, PATH: '' }
  const native = systemPorts(environment)
  let installed = true
  let account = 'first'
  const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, email: account }), stderr: '' }))
  const ports: AccountProbePorts = {
    ...native, find: async name => installed && name === 'claude' ? binary : null, run,
  }
  const read = (refresh = false) => probeComputerAccounts(ports, new AbortController().signal, { refresh })
  return { directory, binary, environment, run, read, account(value: string) { account = value },
    installed(value: boolean) { installed = value } }
}

const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
function ports(installed: string[], outputs: Record<string, { code?: number; stdout?: string; stderr?: string }>,
  files: Record<string, string> = {}): AccountProbePorts {
  return {
    environment: { HOME: '/home/agent' },
    find: async name => installed.includes(name) ? `/usr/bin/${name}` : null,
    run: async (binary, args) => ({ code: 0, stdout: '', stderr: '', ...outputs[`${binary.split('/').at(-1)} ${args.join(' ')}`] }),
    readText: async path => files[path] ?? null,
  }
}

it('reads each tool account without exposing tokens', async () => {
  const result = await probeComputerAccounts(ports(['codex', 'claude', 'gh'], {
    'claude auth status': { stdout: JSON.stringify({ loggedIn: true, email: 'claude@example.com', authMethod: 'claude.ai' }) },
    'gh auth status --active --hostname github.com --json hosts': { stdout: JSON.stringify({ hosts: { 'github.com': [{ login: 'octo-owner', active: true, state: 'success' }] } }) },
  }, { '/home/agent/.codex/auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token({ email: 'codex@example.com' }), refresh_token: 'secret' } }) }))
  expect(result.accounts).toEqual([
    { tool: 'codex', installed: true, signedIn: true, account: 'codex@example.com', details: ['ChatGPT'] },
    { tool: 'claude', installed: true, signedIn: true, account: 'claude@example.com', details: ['claude.ai'] },
    { tool: 'github', installed: true, signedIn: true, account: 'octo-owner', details: [] },
  ])
  expect(JSON.stringify(result)).not.toMatch(/secret|gho_/)
})

it('separates missing tools, signed-out tools and unreadable sign-in state', async () => {
  const signedOut = await probeComputerAccounts(ports(['claude'], {
    'claude auth status': { code: 1, stdout: 'Invalid API key · Please run /login' } }))
  expect(signedOut.accounts.find(value => value.tool === 'claude')?.signedIn).toBe(false)
  await expect(probeComputerAccounts(ports(['codex', 'claude', 'gh'], {
    'claude auth status': { stdout: 'not json' },
    'gh auth status --active --hostname github.com --json hosts': { code: 1, stderr: 'You are not logged into any GitHub hosts.' },
  }))).rejects.toMatchObject({ code: 'COMPUTER_ACCOUNT_UNAVAILABLE' })
})

it.each(['missing', 'unreadable', 'malformed'] as const)(
  'distinguishes missing Codex credentials from unreadable or malformed credentials: %s', async state => {
    const run = vi.fn<AccountProbePorts['run']>()
    const result = probeComputerAccounts({
      ...ports(['codex'], {}),
      run,
      readText: async () => {
        if (state === 'unreadable') throw new Error('Access denied')
        return state === 'missing' ? null : 'not json'
      },
    })
    if (state === 'missing') {
      expect((await result).accounts.find(account => account.tool === 'codex')).toEqual({
        tool: 'codex', installed: true, signedIn: null, account: null, details: [],
      })
    } else {
      await expect(result).rejects.toMatchObject({ code: 'COMPUTER_ACCOUNT_UNAVAILABLE' })
    }
    expect(run).not.toHaveBeenCalled()
  },
)

it('distinguishes unavailable Codex from an installed tool with unknown sign-in', async () => {
  const result = await probeComputerAccounts(ports([], {}))
  expect(result.accounts.find(account => account.tool === 'codex')).toEqual({
    tool: 'codex', installed: false, signedIn: null, account: null, details: [],
  })
})

it('reports an installed Claude that cannot start', async () => {
  await expect(probeComputerAccounts({ ...ports(['claude'], {}),
    run: async () => ({ code: null, stdout: '', stderr: '' }) })).rejects.toMatchObject({
    code: 'COMPUTER_ACCOUNT_UNAVAILABLE',
  })
})



it('chooses the active GitHub account from structured status', async () => {
  const result = await probeComputerAccounts(ports(['gh'], {
    'gh auth status --active --hostname github.com --json hosts': { stdout: JSON.stringify({ hosts: { 'github.com': [
      { login: 'inactive', active: false, state: 'success' },
      { login: 'active-owner', active: true, state: 'success' },
    ] } }) },
  }))
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: true, account: 'active-owner' })
})

it.each([
  { code: null, stdout: '', stderr: '' },
  { code: 1, stdout: '', stderr: 'network timeout' },
  { code: 0, stdout: 'unreadable', stderr: '' },
  { code: 0, stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'owner', state: 'timeout' }] } }), stderr: '' },
])('reports failed or unreadable GitHub status as a typed error', async output => {
  await expect(probeComputerAccounts({ ...ports(['gh'], {}), run: async () => output }))
    .rejects.toMatchObject({ code: 'GITHUB_STATUS_UNKNOWN' })
})

it('uses text status when JSON is unsupported and selects the active account', async () => {
  const calls: string[][] = []
  const result = await probeComputerAccounts({ ...ports(['gh'], {}), run: async (_binary, args) => {
    calls.push(args)
    if (args.includes('--json')) return { code: 1, stdout: '', stderr: 'unknown flag: --json' }
    return { code: 0, stdout: '', stderr: '✓ Logged in to github.com account inactive (keyring)\n - Active account: false\n'
      + '✓ Logged in to github.com account active-owner (keyring)\n - Active account: true\n' }
  } })
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: true, account: 'active-owner' })
  expect(calls[1]).toEqual(['auth', 'status', '--active', '--hostname', 'github.com'])
})

it('supports a single account on old GitHub CLI releases without active or JSON flags', async () => {
  const result = await probeComputerAccounts({ ...ports(['gh'], {}), run: async (_binary, args) => {
    if (args.includes('--active')) return { code: 1, stdout: '', stderr: 'unknown flag: --active' }
    return { code: 0, stdout: '', stderr: '✓ Logged in to github.com account old-owner (keyring)' }
  } })
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: true, account: 'old-owner' })
})

it.each([true, false])('reports GitHub signed-out with another host configured and active support %s', async supportsActive => {
  const result = await probeComputerAccounts({ ...ports(['gh'], {}), run: async (_binary, args) => {
    if (args.includes('--json')) return { code: 1, stdout: '', stderr: 'unknown flag: --json' }
    if (!supportsActive && args.includes('--active')) return { code: 1, stdout: '', stderr: 'unknown flag: --active' }
    return { code: 1, stdout: '', stderr: 'You are not logged into any accounts on github.com' }
  } })
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: false, account: null })
})

it('reuses unchanged account probes and refreshes keyring facts at expiry or on request', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await cachedProbeFixture()
  const first = await f.read()
  expect(first.accounts[1]?.account).toBe('first')
  f.account('second')
  vi.advanceTimersByTime(1000)
  const cached = await f.read()
  expect(cached.accounts[1]?.account).toBe('first')
  expect(cached.observedAt).toBe(first.observedAt)
  expect(f.run).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(30_000)
  expect((await f.read()).accounts[1]?.account).toBe('second')
  f.account('third')
  expect((await f.read(true)).accounts[1]?.account).toBe('third')
  expect(f.run).toHaveBeenCalledTimes(3)
})

it('reprobes when the clock moves backwards instead of extending cached account freshness', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await cachedProbeFixture()
  await f.read()
  f.account('changed')
  vi.setSystemTime(Date.now() - 1000)
  expect((await f.read()).accounts[1]?.account).toBe('changed')
  expect(f.run).toHaveBeenCalledTimes(2)
})

it.each(['overwrite', 'replace', 'symlink'] as const)('reprobes an executable after %s with restored mtime', async method => {
  const f = await cachedProbeFixture()
  await utimes(f.binary, new Date(0), new Date(1000))
  await f.read()
  const before = await stat(f.binary)
  const replacement = join(f.directory, 'replacement')
  if (method === 'overwrite') {
    await writeFile(f.binary, 'modified')
    await utimes(f.binary, before.atime, before.mtime)
  } else {
    await writeFile(replacement, 'modified', { mode: 0o700 })
    await utimes(replacement, before.atime, before.mtime)
    if (method === 'replace') await rename(replacement, f.binary)
    else {
      await rm(f.binary)
      await symlink(replacement, f.binary)
    }
  }
  f.account('replacement')
  expect((await f.read()).accounts[1]?.account).toBe('replacement')
  expect(f.run).toHaveBeenCalledTimes(2)
})

it('reprobes changed credential files and environment without waiting for expiry', async () => {
  const f = await cachedProbeFixture()
  await f.read()
  await mkdir(join(f.directory, '.claude'))
  await writeFile(join(f.directory, '.claude', '.credentials.json'), 'changed')
  f.account('changed-credentials')
  expect((await f.read()).accounts[1]?.account).toBe('changed-credentials')
  f.environment.PATH = 'changed-environment'
  f.account('changed-environment')
  expect((await f.read()).accounts[1]?.account).toBe('changed-environment')
  expect(f.run).toHaveBeenCalledTimes(3)
})

it('reprobes GitHub when its credential configuration changes', async () => {
  const f = await cachedProbeFixture()
  const native = systemPorts(f.environment)
  const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ hosts: {} }), stderr: '' }))
  const ports: AccountProbePorts = { ...native, find: async name => name === 'gh' ? f.binary : null, run }
  const read = () => probeComputerAccounts(ports)
  expect((await read()).accounts[2]?.signedIn).toBe(false)
  await read()
  expect(run).toHaveBeenCalledTimes(1)
  const config = join(f.directory, '.config', 'gh')
  await mkdir(config, { recursive: true })
  await writeFile(join(config, 'hosts.yml'), 'changed')
  expect((await read()).accounts[2]?.signedIn).toBe(false)
  expect(run).toHaveBeenCalledTimes(2)
})

it('does not reuse an installed account when its executable disappears', async () => {
  const f = await cachedProbeFixture()
  await f.read()
  f.installed(false)
  expect((await f.read()).accounts[1]?.installed).toBe(false)
  f.installed(true)
  await rm(f.binary)
  await expect(f.read()).rejects.toMatchObject({ code: 'COMPUTER_ACCOUNT_UNAVAILABLE' })
  await writeFile(f.binary, 'restored', { mode: 0o700 })
  f.account('restored')
  expect((await f.read()).accounts[1]?.account).toBe('restored')
  expect(f.run).toHaveBeenCalledTimes(2)
})

it('retries a failed process probe and shares concurrent successful probes', async () => {
  const f = await cachedProbeFixture()
  f.run.mockRejectedValueOnce(new Error('probe failed'))
  await expect(f.read()).rejects.toMatchObject({ code: 'COMPUTER_ACCOUNT_UNAVAILABLE' })
  const values = await Promise.all([f.read(), f.read()])
  expect(values.every(value => value.accounts[1]?.account === 'first')).toBe(true)
  expect(f.run).toHaveBeenCalledTimes(2)
})
