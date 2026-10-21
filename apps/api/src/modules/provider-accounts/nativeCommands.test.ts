import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAccount } from '@foreman-code/contracts/provider-accounts'
import { NativeProviderAccountCommands, type AccountCommandInvocation,
  type QualifiedAccountInstallation } from './nativeCommands.js'
import { providerAccountEnvironment } from './environment.js'
import { LocalProviderCredentials } from './localCredentials.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function fixture(provider: 'codex' | 'claude', stdout = '', code: number | null = 0, timedOut = false) {
  const id = randomUUID()
  const account: ProviderAccount = { id, provider, name: 'Test account', authMode: 'subscription', revision: 1,
    status: 'unavailable', identity: null, isDefault: false,
    binding: { kind: 'slot', accountId: id, provider, profileRef: id, bindingRevision: 1, subject: null,
      target: { hostRef: { kind: 'main', mainId: randomUUID() }, applicationInstallationId: randomUUID(),
        keyRevision: null, authorizationRevision: null } } }
  const input = { account, homePath: `/slots/${id}/home`, userHome: `/slots/${id}` }
  const installation: QualifiedAccountInstallation = { binding: account.binding!, binary: `/native/${provider}`,
    profilePath: input.homePath, qualificationId: 'qualified-native-interface', generation: 1,
    isolation: true, status: true, login: true, logout: true }
  const selected = vi.fn().mockResolvedValue(installation)
  const calls: AccountCommandInvocation[] = []
  const native = new NativeProviderAccountCommands({ selected }, call => {
    calls.push(call)
    return { completion: Promise.resolve({ code, stdout, timedOut }), stop: async () => undefined }
  })
  return { native, input, installation, selected, calls }
}

describe('qualified native account commands', () => {
  it('selects independent Codex homes and the accepted executable without overriding credential storage', async () => {
    const first = fixture('codex', 'Logged in using ChatGPT')
    const second = fixture('codex', 'Logged in using ChatGPT')
    for (const f of [first, second]) {
      expect(await f.native.status(f.input)).toEqual({ status: 'signed-in', identity: null })
      expect(f.calls[0]).toMatchObject({ binary: '/native/codex', args: ['login', 'status'],
        environment: { CODEX_HOME: f.input.homePath, HOME: f.input.userHome } })
      await f.native.close()
    }
    expect(first.calls[0]!.environment.CODEX_HOME).not.toBe(second.calls[0]!.environment.CODEX_HOME)
  })
  it.each(['unknown command', 'network error', '', 'Logged in using an API key'])(
    'keeps unknown or other-mode Codex status unavailable: %s', async output => {
      const f = fixture('codex', output, 1)
      expect(await f.native.status(f.input)).toEqual({ status: 'unavailable', identity: null })
      await f.native.close()
    })
  it('reports signed out only from an explicit native result and leaves timeout unavailable', async () => {
    const out = fixture('codex', 'Not logged in', 1)
    const timeout = fixture('codex', 'Not logged in', 1, true)
    expect(await out.native.status(out.input)).toEqual({ status: 'signed-out', identity: null })
    expect(await timeout.native.status(timeout.input)).toEqual({ status: 'unavailable', identity: null })
    await Promise.all([out.native.close(), timeout.native.close()])
  })
  it('preserves Claude HOME and XDG context while selecting only its profile and stripping ambient credentials', () => {
    expect(providerAccountEnvironment('claude', '/slots/profile', '/slots/context', {
      HOME: '/human-context', XDG_CONFIG_HOME: '/human-config', ANTHROPIC_API_KEY: 'ambient-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-secret', FOREMAN_CODE_MCP_TOKEN: 'application-grant', PATH: '/bin',
    })).toEqual({ HOME: '/human-context', XDG_CONFIG_HOME: '/human-config', CLAUDE_CONFIG_DIR: '/slots/profile',
      FOREMAN_CODE_MCP_TOKEN: 'application-grant', PATH: '/bin' })
  })
  it('exports qualified subject/email evidence without raw provider output', async () => {
    const f = fixture('claude', JSON.stringify({ loggedIn: true, authMethod: 'subscription',
      email: 'account@example.invalid', accountId: 'provider-subject', accessToken: 'hidden-token' }))
    f.installation.subjectField = 'accountId'
    const observed = await f.native.status(f.input)
    expect(observed).toMatchObject({ status: 'signed-in', identity: 'account@example.invalid',
      subject: { subject: 'provider-subject', provenance: 'qualified-native' } })
    expect(JSON.stringify(observed)).not.toContain('hidden-token')
    expect(f.calls[0]).toMatchObject({ binary: '/native/claude', args: ['auth', 'status', '--json'] })
    await f.native.close()
  })
  it('does not invent a subject or treat API-key mode as subscription', async () => {
    const email = fixture('claude', '{"loggedIn":true,"email":"account@example.invalid","accountId":"unqualified"}')
    const api = fixture('claude', '{"loggedIn":true,"authMethod":"api_key"}')
    expect(await email.native.status(email.input)).toMatchObject({ status: 'signed-in', subject: null })
    expect(await api.native.status(api.input)).toEqual({ status: 'unavailable', identity: null })
    await Promise.all([email.native.close(), api.native.close()])
  })
  it.each(['{}', '{"loggedIn":"unknown"}', 'native error', '{bad-json}'])(
    'leaves unsupported Claude status unavailable: %s', async output => {
      const f = fixture('claude', output)
      expect(await f.native.status(f.input)).toEqual({ status: 'unavailable', identity: null })
      await f.native.close()
    })
  it('rejects control characters in native identity metadata', async () => {
    const f = fixture('claude', JSON.stringify({ loggedIn: true, email: 'unsafe\u0000@example.invalid',
      accountId: 'unsafe\u0000subject' }))
    f.installation.subjectField = 'accountId'
    expect(await f.native.status(f.input)).toEqual({ status: 'signed-in', identity: null, subject: null })
    await f.native.close()
  })
  it('refuses an unqualified installation or a mutation without a reserved operation', async () => {
    const f = fixture('claude')
    f.selected.mockResolvedValue(null)
    expect(await f.native.status(f.input)).toEqual({ status: 'unavailable', identity: null })
    await expect(f.native.login(f.input)).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_REQUIRED' })
    expect(f.calls).toHaveLength(0)
    await f.native.close()
  })
  it('reads the accepted generation without launching a command', async () => {
    const f = fixture('codex')
    f.installation.generation = 4
    expect(await f.native.authenticationGeneration(f.input)).toBe(4)
    expect(f.calls).toHaveLength(0)
    await f.native.close()
  })
  it('rejects ancestor aliases and slot reuse while retaining independent fresh homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'account-slots-'))
    roots.push(root)
    const storage = new LocalProviderCredentials(join(root, 'slots'))
    const first = fixture('codex').input.account
    const second = fixture('codex').input.account
    await storage.create(first)
    await storage.create(second)
    await storage.assertAvailable(first.id)
    await storage.assertAvailable(second.id)
    await expect(storage.create(first)).rejects.toMatchObject({ code: 'ACCOUNT_HOME_REUSED' })
    await symlink(join(root, 'slots'), join(root, 'alias'))
    await expect(new LocalProviderCredentials(join(root, 'alias')).assertAvailable(first.id))
      .rejects.toMatchObject({ code: 'ACCOUNT_HOME_UNSAFE' })
  })
})
