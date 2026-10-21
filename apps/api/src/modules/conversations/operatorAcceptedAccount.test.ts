import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, OperatorConfigurationVersionSchema, operatorChatSettings } from '@foreman-code/contracts'
import { acceptOperatorConfiguration } from './operatorAcceptedConfiguration.js'
import { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'

const accountId = '10000000-0000-4000-8000-000000000001'
const otherId = '10000000-0000-4000-8000-000000000002'
const saved = OperatorConfigurationVersionSchema.parse({ id: 'accepted-operator-configuration',
  operatorId: 'operator', version: 1, harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId },
  contentHash: `sha256:${'a'.repeat(64)}`, createdAt: '2026-01-01T00:00:00.000Z' })

it('returns the original accepted configuration before consulting changed defaults or message controls', async () => {
  const resolve = vi.fn(async () => ({ accountId: otherId, homePath: '/profiles/other', authMode: 'subscription' as const }))
  const accounts = new ProviderAccountConfigurationService({ resolve })
  const current = { ...saved, id: 'later-configuration', harness: { ...saved.harness, accountId: otherId } }
  const accepted = await acceptOperatorConfiguration({ query: async () => ({ rows: [{ record: saved }] }) } as never,
    current, { requestId: 'accepted-command', content: 'Continue', settings: { ...operatorChatSettings(saved.harness), accountId: otherId } },
    { operator_configuration_version_id: saved.id }, undefined, undefined, accounts)
  expect(accepted).toEqual(saved)
  expect(resolve).not.toHaveBeenCalled()
})

it('keeps a legacy saved Operator profile rather than adding today’s default account', async () => {
  const legacy = OperatorConfigurationVersionSchema.parse({ ...saved, harness: DEFAULT_HARNESS_DEFAULTS.codex })
  const resolve = vi.fn(async () => ({ accountId: otherId, homePath: '/profiles/other', authMode: 'subscription' as const }))
  const result = await acceptOperatorConfiguration({ query: async () => ({ rows: [] }) } as never, legacy,
    { requestId: 'new-command', content: 'Continue' }, undefined, undefined, undefined,
    new ProviderAccountConfigurationService({ resolve }))
  expect(result).toEqual(legacy)
  expect(resolve).not.toHaveBeenCalled()
})
