import { expect, it, vi } from 'vitest'
import { OperatorConfigurationVersionSchema, operatorChatSettings } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { acceptOperatorConfiguration } from './operatorAcceptedConfiguration.js'
import { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'

const first = '5aa52a3c-c3f7-44cf-b575-dd8ab43b7b4e'
const second = '92a1d19c-a77b-4cd2-936b-518756a6f7ef'
function profile(id: string): HarnessProfileSelection {
  return { instanceId: id, instanceRevision: '1', target: { hostRef: { kind: 'main', mainId: first },
    applicationInstallationId: first, harnessInstallationId: 'claude-installed', installationFingerprint: 'payload' } }
}
const current = OperatorConfigurationVersionSchema.parse({ id: 'operator-config', operatorId: 'operator', version: 1,
  createdAt: '2026-01-01T00:00:00Z', contentHash: `sha256:${'a'.repeat(64)}`, harnessProfileSelection: profile(first),
  harness: { harness: 'claude', accountId: first, model: 'recorded-model', authMode: 'subscription',
    configDirectory: '/accounts/first/home', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: [], permissionRules: [], instructions: '', mcpServers: {} } })
const accounts = new ProviderAccountConfigurationService({ async resolve(_provider, id) {
  return { accountId: id!, homePath: id === first ? '/accounts/first/home' : '/accounts/second/home',
    authMode: 'subscription' }
} })
const input = { requestId: 'switch-account', content: 'Continue',
  settings: { ...operatorChatSettings(current.harness), accountId: second } }

it('refuses another Claude account when only the previous account profile is available', async () => {
  const query = vi.fn()
  await expect(acceptOperatorConfiguration({ query } as never, current, input, undefined,
    undefined, undefined, accounts)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
  expect(query).not.toHaveBeenCalled()
})

it('persists the checked account home and its separately prepared profile into the accepted Operator configuration', async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ version: 2 }] })
    .mockResolvedValueOnce({ rows: [] })
  const validate = vi.fn()
  const accepted = await acceptOperatorConfiguration({ query } as never, current, input, undefined,
    undefined, validate, accounts, profile(second))
  expect(accepted.harness).toMatchObject({ accountId: second, configDirectory: '/accounts/second/home' })
  expect(accepted.harnessProfileSelection).toEqual(profile(second))
  expect(validate).toHaveBeenCalledWith(expect.objectContaining({ harnessProfileSelection: profile(second) }))
  const persisted = JSON.parse(query.mock.calls.at(-1)![1][3] as string)
  expect(persisted).toEqual(accepted)
  expect(current.harness).toMatchObject({ accountId: first, configDirectory: '/accounts/first/home' })
})
