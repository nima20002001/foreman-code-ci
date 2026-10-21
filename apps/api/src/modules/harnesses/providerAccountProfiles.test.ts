import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { ProviderAccountConfigurationService } from './providerAccountConfiguration.js'

it('retains an explicitly selected Worker Claude profile and its live grant validation', async () => {
  const accountId = randomUUID()
  const target = { hostRef: { kind: 'device' as const, mainId: randomUUID(), deviceId: randomUUID() },
    applicationInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const configuration = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', accountId,
    model: 'saved-model', authMode: 'subscription', configDirectory: '/fixture/worker-profile',
    permissionMode: 'default', sandbox: 'read-only', tools: [], permissionRules: [], instructions: '', mcpServers: {} })
  const selection: HarnessProfileSelection = { instanceId: randomUUID(), instanceRevision: 'saved-revision',
    target: { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
      harnessInstallationId: 'qualified-native', installationFingerprint: 'qualified-fingerprint' } }
  const accounts = new ProviderAccountConfigurationService({ resolve: async () => ({ accountId, homePath: '',
    authMode: 'subscription', binding: { kind: 'slot', provider: 'claude', accountId, target,
      profileRef: 'worker-profile', bindingRevision: 1, subject: null } }) })
  const validateSelection = vi.fn(async () => {})
  const profiles = { validateSelection, selectionForConfiguration: vi.fn(async () => undefined),
    prepareOperatorConfiguration: vi.fn(async () => undefined) }
  accounts.bindProfiles(profiles)
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Profile reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] }
  const input = { configuration, selection, principal, source: 'mcp' as const,
    commandId: randomUUID(), client: {} as pg.PoolClient, check: true }
  expect(await accounts.profile(input)).toEqual(selection)
  expect(await accounts.resolve(configuration, selection)).toEqual(configuration)
  validateSelection.mockRejectedValueOnce(new DomainError('ACCESS_DENIED', 'Profile access was revoked.', 403))
  await expect(accounts.profile(input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(profiles.selectionForConfiguration).not.toHaveBeenCalled()
  expect(profiles.prepareOperatorConfiguration).not.toHaveBeenCalled()
  await expect(accounts.profile({ ...input, selection: { ...selection, target: { ...selection.target,
    hostRef: { ...target.hostRef, mainId: randomUUID() } } } }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
})
