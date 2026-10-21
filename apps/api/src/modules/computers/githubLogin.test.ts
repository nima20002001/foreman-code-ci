import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { GitHubLoginRunner, type GitHubLoginPorts } from './githubLogin.js'

function fixture(installed = true, options: {
  firstLookup?: Promise<void>
  unreadable?: boolean
  setupFails?: boolean
  logoutKeepsAccount?: boolean
  logoutFails?: boolean
  nextAccount?: string
  unreadableAfterLogout?: boolean
  logoutWait?: Promise<void>
  textStatus?: boolean
  otherHost?: boolean
  statusError?: Error
} = {}) {
  let user: string | null = null
  const children: { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; emitter: EventEmitter; kill: ReturnType<typeof vi.fn>; args: string[] }[] = []
  const runs: string[] = []
  let lookups = 0
  const ports: GitHubLoginPorts = {
    now: () => Date.parse('2026-10-07T00:00:00Z'),
    spawn: (_binary, args) => {
      const emitter = new EventEmitter()
      const child = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), emitter, args,
        kill: vi.fn(() => { emitter.emit('exit', null) }) }
      children.push(child)
      return { stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, kill: child.kill,
        once: (event: string, listener: (...values: unknown[]) => void) => { emitter.once(event, listener); return undefined as never } } as never
    },
    probe: {
      environment: {},
      find: async name => {
        if (++lookups === 1 && options.firstLookup) await options.firstLookup
        return installed && name === 'gh' ? '/usr/bin/gh' : null
      },
      readText: async () => null,
      run: async (_binary, args) => {
        runs.push(args.join(' '))
        if (args[1] === 'status' && options.statusError) throw options.statusError
        if (args[1] === 'status' && options.unreadable) return { code: null, stdout: '', stderr: '' }
        if (args[1] === 'status' && args.includes('--json') && options.textStatus) {
          return { code: 1, stdout: '', stderr: 'unknown flag: --json' }
        }
        if (args[1] === 'setup-git' && options.setupFails) return { code: 1, stdout: '', stderr: 'cannot write git config' }
        if (args[1] === 'status' && !args.includes('--json')) {
          if (user) return { code: 0, stdout: '',
            stderr: `✓ Logged in to github.com account ${user} (keyring)\n - Active account: true` }
          const stderr = options.otherHost
            ? 'You are not logged into any accounts on github.com' : 'You are not logged into any GitHub hosts.'
          return { code: 1, stdout: '', stderr }
        }
        if (args[1] === 'status') return user ? { code: 0, stderr: '', stdout: JSON.stringify({ hosts: { 'github.com': [{ login: user, active: true, state: 'success' }] } }) }
          : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }
        if (args[1] === 'logout' && options.logoutWait) await options.logoutWait
        if (args[1] === 'logout' && options.logoutFails) return { code: 1, stdout: '', stderr: 'logout failed' }
        if (args[1] === 'logout' && !options.logoutKeepsAccount) {
          user = options.nextAccount ?? null
          if (options.unreadableAfterLogout) options.unreadable = true
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { options, runner: new GitHubLoginRunner(ports), children, runs, signIn: (name: string) => { user = name } }
}

it('returns the device code, follows the CLI to signed-in and lets git use the account', async () => {
  const f = fixture()
  const started = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(1), { interval: 1 })
  f.children[0]!.stderr.write('! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n')
  const waiting = await started
  expect(waiting).toMatchObject({ state: 'waiting', code: 'AB12-CD34', verificationUrl: 'https://github.com/login/device' })
  expect(f.children[0]!.args).toEqual(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'])
  expect(await f.runner.handle({ operation: 'login-status', loginId: waiting.loginId! })).toMatchObject({ state: 'waiting' })
  f.signIn('octo-owner')
  f.children[0]!.emitter.emit('exit', 0)
  await vi.waitFor(async () => expect(await f.runner.handle({ operation: 'login-status', loginId: waiting.loginId! }))
    .toMatchObject({ state: 'signed-in', account: 'octo-owner', code: null }), { interval: 1 })
  expect(f.runs).toContain('auth setup-git --hostname github.com')
  expect(await f.runner.handle({ operation: 'logout', expectedAccount: 'octo-owner' })).toMatchObject({ state: 'signed-out', account: null })
  expect(f.runs).toContain('auth logout --hostname github.com --user octo-owner')
})

it('reports a failed sign-in, replaces an earlier one and refuses without the GitHub CLI', async () => {
  const f = fixture()
  const first = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(1), { interval: 1 })
  f.children[0]!.stdout.write('one-time code: AAAA-1111\n')
  const one = await first
  const second = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(2), { interval: 1 })
  expect(f.children[0]!.kill).toHaveBeenCalled()
  f.children[1]!.stdout.write('one-time code: BBBB-2222\n')
  const two = await second
  await expect(f.runner.handle({ operation: 'login-status', loginId: one.loginId! })).rejects.toMatchObject({ code: 'GITHUB_LOGIN_NOT_FOUND' })
  f.children[1]!.emitter.emit('exit', 1)
  await vi.waitFor(async () => expect(await f.runner.handle({ operation: 'login-status', loginId: two.loginId! }))
    .toMatchObject({ state: 'failed' }), { interval: 1 })
  await expect(fixture(false).runner.handle({ operation: 'login-start' })).rejects.toMatchObject({ code: 'GITHUB_CLI_MISSING' })
})


it('refuses to report signed-out when the probe cannot establish the account', async () => {
  const f = fixture(true, { unreadable: true })
  await expect(f.runner.handle({ operation: 'logout', expectedAccount: 'owner' })).rejects.toMatchObject({ code: 'GITHUB_STATUS_UNKNOWN' })
  expect(f.runs.some(value => value.startsWith('auth logout'))).toBe(false)
})

it('checks the account after logout and refuses success when credentials remain', async () => {
  const f = fixture(true, { logoutKeepsAccount: true })
  f.signIn('owner')
  await expect(f.runner.handle({ operation: 'logout', expectedAccount: 'owner' })).rejects.toMatchObject({ code: 'GITHUB_LOGOUT_FAILED' })
  expect(f.runs.filter(value => value.startsWith('auth status'))).toHaveLength(2)
})

it('verifies logout on older GitHub CLI releases while another host remains configured', async () => {
  const f = fixture(true, { textStatus: true, otherHost: true })
  f.signIn('owner')
  expect(await f.runner.handle({ operation: 'logout', expectedAccount: 'owner' })).toMatchObject({ state: 'signed-out', account: null })
  expect(f.runs).toContain('auth logout --hostname github.com --user owner')
  expect(f.runs.filter(value => value === 'auth status --active --hostname github.com')).toHaveLength(2)
})

it('keeps a newer login when the replaced request fails before offering its code', async () => {
  const f = fixture()
  const first = f.runner.handle({ operation: 'login-start' })
  const failed = expect(first).rejects.toMatchObject({ code: 'GITHUB_LOGIN_FAILED' })
  await vi.waitFor(() => expect(f.children).toHaveLength(1), { interval: 1 })
  const second = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(2), { interval: 1 })
  f.children[1]!.stdout.write('one-time code: BBBB-2222\n')
  const waiting = await second
  await failed
  expect(await f.runner.handle({ operation: 'login-status', loginId: waiting.loginId! })).toMatchObject({ code: 'BBBB-2222' })
  f.runner.close()
})

it('reports Git setup failure separately after successful sign-in', async () => {
  const f = fixture(true, { setupFails: true })
  const started = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(1), { interval: 1 })
  f.children[0]!.stdout.write('one-time code: AAAA-1111\n')
  const waiting = await started
  f.signIn('owner')
  f.children[0]!.emitter.emit('exit', 0)
  await vi.waitFor(async () => expect(await f.runner.handle({ operation: 'login-status', loginId: waiting.loginId! }))
    .toMatchObject({ state: 'git-setup-failed', account: 'owner' }), { interval: 1 })
  f.options.setupFails = false
  expect(await f.runner.handle({ operation: 'setup-git', loginId: waiting.loginId! })).toMatchObject({ state: 'signed-in', account: 'owner' })
  expect(f.children).toHaveLength(1)
})


it('reports another saved account as signed-in when logout makes it active', async () => {
  const f = fixture(true, { nextAccount: 'another-owner' })
  f.signIn('owner')
  expect(await f.runner.handle({ operation: 'logout', expectedAccount: 'owner' })).toMatchObject({ state: 'signed-in', account: 'another-owner' })
  expect(f.runs).toContain('auth logout --hostname github.com --user owner')
})

it('does not claim signed-out after logout fails or the verification probe fails', async () => {
  const failed = fixture(true, { logoutFails: true })
  failed.signIn('owner')
  await expect(failed.runner.handle({ operation: 'logout', expectedAccount: 'owner' })).rejects.toMatchObject({ code: 'GITHUB_LOGOUT_FAILED' })
  const unknown = fixture(true, { unreadableAfterLogout: true })
  unknown.signIn('owner')
  await expect(unknown.runner.handle({ operation: 'logout', expectedAccount: 'owner' })).rejects.toMatchObject({ code: 'GITHUB_STATUS_UNKNOWN' })
})


it('starts a requested account switch only after pending logout has checked the removed credentials', async () => {
  let finishLogout!: () => void
  const logoutWait = new Promise<void>(resolve => { finishLogout = resolve })
  const f = fixture(true, { logoutWait })
  f.signIn('owner')
  const logout = f.runner.handle({ operation: 'logout', expectedAccount: 'owner' })
  await vi.waitFor(() => expect(f.runs).toContain('auth logout --hostname github.com --user owner'), { interval: 1 })
  const start = f.runner.handle({ operation: 'login-start' })
  // Drain queued continuations while logout remains explicitly blocked.
  await new Promise<void>(resolve => setImmediate(resolve))
  try {
    expect(f.children).toHaveLength(0)
  } finally {
    finishLogout()
    if (f.children[0]) {
      f.children[0].stdout.write('one-time code: BBBB-2222\n')
      f.runner.close()
    }
  }
  expect(await logout).toMatchObject({ state: 'signed-out' })
  await vi.waitFor(() => expect(f.children).toHaveLength(1), { interval: 1 })
  f.children[0]!.stdout.write('one-time code: BBBB-2222\n')
  const waiting = await start
  f.signIn('switched-owner')
  f.children[0]!.emitter.emit('exit', 0)
  await vi.waitFor(async () => expect(await f.runner.handle({ operation: 'login-status', loginId: waiting.loginId! }))
    .toMatchObject({ state: 'signed-in', account: 'switched-owner' }), { interval: 1 })
})


it('preserves the next saved account on an uncertain logout retry and overlapping duplicates', async () => {
  const f = fixture(true, { nextAccount: 'another-owner', unreadableAfterLogout: true })
  f.signIn('owner')
  const request = { operation: 'logout' as const, expectedAccount: 'owner' }
  await expect(f.runner.handle(request)).rejects.toMatchObject({ code: 'GITHUB_STATUS_UNKNOWN' })
  f.options.unreadable = false
  await Promise.all([1, 2].map(async () => {
    await expect(f.runner.handle(request)).rejects.toMatchObject({ code: 'GITHUB_ACCOUNT_CHANGED' })
  }))
  expect(f.runs.filter(value => value.startsWith('auth logout')))
    .toEqual(['auth logout --hostname github.com --user owner'])
  f.runner.close()
})

it.each(['logout', 'close'] as const)('cancels a login whose executable lookup finishes after %s', async operation => {
  let release!: () => void
  const firstLookup = new Promise<void>(resolve => { release = resolve })
  const f = fixture(true, { firstLookup })
  const start = f.runner.handle({ operation: 'login-start' })
  const cancelled = expect(start).rejects.toMatchObject({ code: 'GITHUB_LOGIN_CANCELLED' })
  if (operation === 'logout') {
    expect(await f.runner.handle({ operation: 'logout', expectedAccount: null })).toMatchObject({ state: 'signed-out' })
  } else {
    f.runner.close()
  }
  release()
  await cancelled
  expect(f.children).toHaveLength(0)
  f.runner.close()
})

it('keeps process failures typed and does not attempt logout after an uncertain probe', async () => {
  const f = fixture(true, { statusError: new Error('status transport failed') })
  await expect(f.runner.handle({ operation: 'logout', expectedAccount: 'owner' }))
    .rejects.toMatchObject({ code: 'GITHUB_STATUS_UNKNOWN' })
  expect(f.runs.some(run => run.startsWith('auth logout'))).toBe(false)
  f.runner.close()
})
