import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { assertAccountConfiguration, legacyProviderAccountBinding } from './acceptedBindings.js'

const mainId = randomUUID()
const binding: ProviderAccountBinding = { kind: 'slot', accountId: randomUUID(), provider: 'codex',
  target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }, profileRef: 'native-profile', bindingRevision: 1, subject: null }

describe('accepted native account/profile selection', () => {
  it('keeps an ID-less saved profile and its historical principal unknown', () => {
    const configuration = DEFAULT_HARNESS_DEFAULTS.codex
    expect(legacyProviderAccountBinding(configuration)).toEqual({ kind: 'legacy-profile', provider: 'codex',
      target: null, profileRef: null, historicalSubject: 'unknown' })
    expect(legacyProviderAccountBinding({ ...configuration, accountId: binding.accountId }))
      .toMatchObject({ kind: 'legacy-profile', accountId: binding.accountId, historicalSubject: 'unknown' })
    expect(configuration).not.toHaveProperty('accountId')
  })

  it('requires the same explicit account and canonical owning installation', () => {
    expect(() => assertAccountConfiguration(binding,
      { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId: binding.accountId })).not.toThrow()
    expect(() => assertAccountConfiguration(binding,
      { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId: randomUUID() })).toThrow('another account')
    expect(() => assertAccountConfiguration(binding, DEFAULT_HARNESS_DEFAULTS.codex, {
      instanceId: randomUUID(), instanceRevision: 'profile-revision', target: {
        hostRef: binding.target.hostRef, applicationInstallationId: randomUUID(),
        harnessInstallationId: 'qualified-installation', installationFingerprint: 'installed-fingerprint',
      },
    })).toThrow('another installation')
  })
})
