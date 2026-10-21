import { describe, expect, it } from 'vitest'
import { ProviderAccountApiKeyInputSchema } from './providerAccounts.js'
import { applyOperatorChatSettings, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings } from './index.js'
import { ClaudeHarnessConfigurationSchema } from './claude.js'
import { AcceptedProviderAccountBindingSchema, ProviderAccountBindingSchema, ProviderAccountListInputSchema,
  ProviderAccountAuthenticationOperationSchema, ProviderAccountNativeAuthenticationObservationSchema,
  ProviderAccountSchema } from './providerAccounts.js'
import { ProviderAccountDefaultSchema, ProviderAccountRegisterInputSchema } from './providerAccounts.js'

const binding = {
  kind: 'slot' as const, accountId: '10000000-0000-4000-8000-000000000001', provider: 'codex' as const,
  target: { hostRef: { kind: 'main' as const, mainId: '10000000-0000-4000-8000-000000000002' },
    applicationInstallationId: '10000000-0000-4000-8000-000000000002',
    keyRevision: null, authorizationRevision: null },
  profileRef: 'isolated-native-profile', bindingRevision: 1, subject: null,
}

describe('accepted account contracts', () => {
  it('validates independently revisioned defaults and requires opaque qualified profile references', () => {
    expect(ProviderAccountDefaultSchema.parse({ target: binding.target, provider: 'codex',
      accountId: binding.accountId, revision: 3 }).revision).toBe(3)
    expect(ProviderAccountDefaultSchema.safeParse({ target: binding.target, provider: 'codex',
      accountId: binding.accountId, revision: -1 }).success).toBe(false)
    expect(ProviderAccountRegisterInputSchema.safeParse({ commandId: 'register-profile-command', expectedRevision: 0,
      provider: 'claude', authMode: 'subscription', name: 'Profile', profileRef: '/caller/profile',
      qualificationId: 'qualified-reference' }).success).toBe(false)
  })
  it('requires a canonical slot binding and keeps historical identity unknown', () => {
    expect(ProviderAccountBindingSchema.parse(binding)).toEqual(binding)
    expect(ProviderAccountBindingSchema.safeParse({ ...binding, bindingRevision: 0 }).success).toBe(false)
    expect(AcceptedProviderAccountBindingSchema.safeParse({ kind: 'legacy-profile', provider: 'codex',
      target: null, profileRef: null, historicalSubject: 'unknown' }).success).toBe(true)
    expect(AcceptedProviderAccountBindingSchema.safeParse({}).success).toBe(false)
  })

  it('bounds pagination and rejects caller paths and secret native output', () => {
    expect(ProviderAccountListInputSchema.parse({ limit: 10 }).limit).toBe(10)
    for (const limit of [0, 101]) expect(ProviderAccountListInputSchema.safeParse({ limit }).success).toBe(false)
    expect(ProviderAccountBindingSchema.safeParse({ ...binding, homePath: '/native/profile' }).success).toBe(false)
    expect(ProviderAccountNativeAuthenticationObservationSchema.safeParse({ operationId: binding.accountId,
      binding, generation: 1, sequence: 0, state: 'awaiting-human', nativeClosed: false,
      deviceCode: 'secret-challenge' }).success).toBe(false)
  })

  it('reads old metadata while requiring positive closure for canceled authentication', () => {
    expect(ProviderAccountSchema.safeParse({ id: binding.accountId, provider: 'codex', name: 'Account',
      authMode: 'subscription', isDefault: false, status: 'signed-out', identity: null, revision: 0 }).success).toBe(true)
    const operation = { id: binding.accountId, commandId: 'authentication-command',
      inputHash: `sha256:${'a'.repeat(64)}`, binding, intent: 'sign-in', state: 'canceled', revision: 1,
      generation: 1, nativeSequence: 0, cancelRequested: true, nativeClosed: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T01:00:00.000Z', humanActionRequired: false }
    expect(ProviderAccountAuthenticationOperationSchema.safeParse(operation).success).toBe(false)
    expect(ProviderAccountAuthenticationOperationSchema.safeParse({ ...operation, nativeClosed: true }).success).toBe(true)
  })
})

const input = { commandId: 'account-key-command', expectedRevision: 1 }
const apiKey = 'sk-test-provider-account-key'

describe('provider account API key validation', () => {
  it('accepts a key and trims surrounding whitespace', () => {
    expect(ProviderAccountApiKeyInputSchema.parse({ ...input, apiKey: ` ${apiKey}\n` }))
      .toEqual({ ...input, apiKey })
  })

  it.each(Array.from({ length: 32 }, (_, code) => code))('rejects embedded control character %i', code => {
    expect(ProviderAccountApiKeyInputSchema.safeParse({
      ...input, apiKey: `${apiKey}${String.fromCharCode(code)}suffix`,
    }).success).toBe(false)
  })

  it.each([' ', '\u00a0'])('rejects embedded whitespace %j', whitespace => {
    expect(ProviderAccountApiKeyInputSchema.safeParse({
      ...input, apiKey: `${apiKey}${whitespace}suffix`,
    }).success).toBe(false)
  })
})

describe('provider account chat settings', () => {
  const configurations = [
    DEFAULT_HARNESS_DEFAULTS.codex,
    ClaudeHarnessConfigurationSchema.parse({
      harness: 'claude', model: 'saved-claude-model', authMode: 'subscription',
      configDirectory: '/accounts/claude/home', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: [], permissionRules: [], instructions: '', mcpServers: {},
    }),
  ]

  it.each(configurations)('preserves unchanged $harness configuration without an account', configuration => {
    expect(applyOperatorChatSettings(configuration, operatorChatSettings(configuration)))
      .toStrictEqual(configuration)
  })

  it.each(configurations)('clears a selected $harness account when controls omit it', configuration => {
    const selected = { ...configuration, accountId: '10000000-0000-4000-8000-000000000001' }
    expect(applyOperatorChatSettings(selected, operatorChatSettings(configuration)))
      .toStrictEqual(configuration)
    expect(selected.accountId).toBe('10000000-0000-4000-8000-000000000001')
  })
})

describe('account discovery and full model contracts', () => {
  it('preserves native reasoning, variants, service tiers and catalog provenance', async () => {
    const { ProviderAccountModelsSchema } = await import('./providerAccounts.js')
    const model = { id: 'selected-model', name: 'Selected model', providerId: 'native-provider',
      reasoningEfforts: ['high'], variants: ['fast'], serviceTiers: ['priority'], releasedAt: '2026-01-01', defaultPriority: 1 }
    expect(ProviderAccountModelsSchema.parse({ binding, generation: 2, observedAt: '2026-01-01T00:00:00.000Z', models: [model] }).models)
      .toEqual([model])
  })

  it('rejects paths and secrets in selectable profiles and ordinary discovery/readback', async () => {
    const { ProviderAccountProfilesSchema, ProviderAccountNativeDiscoverySchema, ProviderAccountWorkerRequestSchema } =
      await import('./providerAccounts.js')
    const profile = { provider: 'codex', profileRef: 'qualified-profile', qualificationId: 'storage-proof',
      authMode: 'subscription', label: 'Native profile' }
    expect(ProviderAccountProfilesSchema.safeParse({ target: binding.target, profiles: [{ ...profile, profileRef: '/arbitrary/path' }] }).success)
      .toBe(false)
    expect(ProviderAccountProfilesSchema.safeParse({ target: binding.target, profiles: [{ ...profile, token: 'secret' }] }).success)
      .toBe(false)
    expect(ProviderAccountNativeDiscoverySchema.safeParse({ generation: 1, providers: [], profiles: [profile], deviceCode: 'challenge' }).success)
      .toBe(false)
    expect(ProviderAccountWorkerRequestSchema.safeParse({ version: 1, target: binding.target,
      request: { kind: 'shell', command: 'unsupported' } }).success).toBe(false)
  })
})
