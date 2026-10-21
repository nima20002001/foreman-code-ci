import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { ProductionHostHarnessProfileQualifier } from './productionProfileQualifier.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './claudeSdk/profileRevision.js'

function fixture(harness: 'codex' | 'claude') {
  const hostRef = { kind: 'device' as const, mainId: randomUUID(), deviceId: randomUUID() }
  const applicationInstallationId = randomUUID()
  const accountId = randomUUID()
  const defaults = harness === 'codex' ? withAdvancedDefaults(DEFAULT_HARNESS_DEFAULTS.codex)
    : { harness: 'claude' as const, model: 'model', authMode: 'subscription' as const, configDirectory: '/profile',
      permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: ['Write'],
      permissionRules: [], instructions: '', mcpServers: {} }
  const configuration = { ...defaults, accountId }
  const value = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
    target: { hostRef, applicationInstallationId, harnessInstallationId: harness, installationFingerprint: 'installed' },
    driverId: harness, presetId: harness, enabled: true, configuration,
    configurationFingerprint: commandInputHash(configuration), qualification: 'unqualified' } as HostHarnessOverride
  const proof = { target: value.target, instanceRevision: '1', configurationFingerprint: value.configurationFingerprint,
    driverId: harness, driverRevision: '1', protocolRevision: 'native',
    suiteRevision: harness === 'claude' ? CLAUDE_PROFILE_CHECK_REVISION : 'codex-profile-check-v1',
    environmentGeneration: 'environment', connectionGeneration: 'connection', authenticated: true,
    compatible: true, qualified: true, checkedAt: new Date().toISOString() }
  const account = { accountId, homePath: '', authMode: configuration.harness === 'claude' ? configuration.authMode : 'subscription',
    binding: { kind: 'slot', accountId, provider: harness, target: { hostRef: { ...hostRef }, applicationInstallationId,
      keyRevision: 1, authorizationRevision: 1 }, profileRef: accountId, bindingRevision: 1, subject: null } }
  const resolve = vi.fn(async () => account)
  const request = vi.fn(async () => ({ payload: proof }))
  const qualifier = new ProductionHostHarnessProfileQualifier({ pinOverride: () => ({ installation: proof }),
    installations: { assertCurrent: vi.fn() } } as never, {} as never,
  () => ({ clockReason: () => null, capabilities: () => [{ namespace: 'host-harness-check-v1', mainCanRequest: true }],
    request }) as never, '/workspace', undefined,
  new WorkerExecutionPolicy({ enabled: true, managedBy: 'settings' }), { resolve } as never)
  return { account, value, qualifier, request, resolve }
}

it.each(['codex', 'claude'] as const)('qualifies %s on the Worker that owns its managed account', async harness => {
  const f = fixture(harness)
  await expect(f.qualifier.qualify(f.value, { checkId: randomUUID(), signal: new AbortController().signal }))
    .resolves.toMatchObject({ qualified: true, target: f.value.target })
  expect(f.resolve).toHaveBeenCalledWith(harness, f.account.accountId)
  expect(f.request).toHaveBeenCalledWith(f.value.target.hostRef.kind === 'device' && f.value.target.hostRef.deviceId,
    'host-harness-check-v1', expect.objectContaining({ override: f.value }), expect.any(Object))
})

it.each(['computer', 'installation'] as const)('rejects an account owned by another %s before Worker dispatch', async mismatch => {
  const f = fixture('claude')
  if (mismatch === 'computer') f.account.binding.target.hostRef.deviceId = randomUUID()
  else f.account.binding.target.applicationInstallationId = randomUUID()
  await expect(f.qualifier.qualify(f.value, { checkId: randomUUID(), signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
  expect(f.request).not.toHaveBeenCalled()
})
