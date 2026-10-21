import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ProviderAccount, ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { RegistryHarnessSelection } from '../harnesses/installationRegistry.js'
import { privateDirectory, writeRecord } from '../harnesses/recovery/storage.js'
import { ownedTestPath } from '../../../test/helpers/testResources.js'
import { createProductionAccountSelection, type AccountIsolationQualification } from './productionSelection.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function fixture() {
  const root = privateDirectory(ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `account-selection-${randomUUID()}`)))
  roots.push(root)
  const mainId = randomUUID()
  const binding: ProviderAccountBinding = { kind: 'slot', provider: 'codex', accountId: randomUUID(),
    profileRef: 'existing-profile', bindingRevision: 1, subject: null,
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null } }
  const record: AccountIsolationQualification = { qualificationId: 'storage-isolation', provider: 'codex', target: binding.target,
    generation: 3,
    expiresAt: '2099-01-01T00:00:00.000Z', isolation: true, storage: 'provider-keyring',
    scope: { kind: 'existing-profile', homePath: root, userHome: root,
      choice: { profileRef: binding.profileRef, qualificationId: 'storage-isolation', provider: 'codex',
        authMode: 'subscription', label: 'Selected native profile' } },
    actions: ['status', 'models', 'sign-in', 'cancel', 'human-handoff'],
    override: { instanceId: randomUUID(), revision: 1, instanceRevision: 'qualified-revision', presetId: 'preset', enabled: true,
      driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex, configurationFingerprint: 'config-fingerprint',
      qualification: 'qualified', target: { hostRef: binding.target.hostRef, applicationInstallationId: mainId,
        harnessInstallationId: 'installed-codex', installationFingerprint: 'actual-fingerprint' } } }
  const selected = { inventoryRevision: 3, installation: { launcher: { resolvedLauncher: '/fixture/selected-codex' } },
    instance: { instanceId: record.override.instanceId }, selection: { installationFingerprint: 'actual-fingerprint' } } as RegistryHarnessSelection
  const pin = vi.fn(() => selected)
  const validate = vi.fn(async () => {})
  const models = vi.fn(async () => ({ binding, generation: 3, observedAt: '2026-01-01T00:00:00.000Z', models: [] }))
  const path = join(root, 'qualification.json')
  const source = createProductionAccountSelection({ path, pin, validate,
    managedPaths: () => ({ homePath: root, userHome: root }), models })
  const account: ProviderAccount = { id: binding.accountId, provider: 'codex', authMode: 'subscription', binding,
    name: 'Selected slot', isDefault: false, status: 'unavailable', identity: null, revision: 1 }
  const save = () => writeRecord(path, { version: 1, records: [record] })
  return { source, root, record, binding, account, pin, validate, models, save, path, selected }
}

it('resolves registered profile paths without native discovery and refreshes before native use', async () => {
  const f = fixture()
  f.save()
  expect(await f.source.resolveProfile!(f.account)).toEqual({ binding: f.binding,
    homePath: f.root, userHome: f.root })
  expect(f.validate).not.toHaveBeenCalled()
  expect(f.pin).toHaveBeenCalledWith(f.record)

  await f.source.selected({ account: f.account, homePath: f.root, userHome: f.root })
  expect(f.validate).toHaveBeenCalledExactlyOnceWith(f.record)
  f.validate.mockRejectedValueOnce(new Error('Installation discovery failed'))
  await expect(f.source.selected({ account: f.account, homePath: f.root, userHome: f.root }))
    .rejects.toThrow('Installation discovery failed')

  f.pin.mockImplementation(() => { throw new Error('The installed payload changed') })
  await expect(f.source.resolveProfile!(f.account)).rejects.toThrow('installed payload changed')
  f.record.expiresAt = '2000-01-01T00:00:00.000Z'
  f.save()
  await expect(f.source.resolveProfile!(f.account)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNQUALIFIED' })
})

it('keeps production account support unavailable without explicit installer-owned isolation evidence', async () => {
  const f = fixture()
  expect(await f.source.discover!(f.binding.target)).toMatchObject({ profiles: [], providers: [
    { provider: 'codex', qualified: false, actions: [] }, { provider: 'claude', qualified: false, actions: [] },
  ] })
  await expect(f.source.selected({ account: f.account, homePath: f.root, userHome: f.root })).rejects.toMatchObject({
    code: 'PROVIDER_ACCOUNT_UNQUALIFIED',
  })
  expect(f.pin).not.toHaveBeenCalled()
  expect(f.models).not.toHaveBeenCalled()
})

it('uses the current installed launcher and returns only opaque qualified profile choices', async () => {
  const f = fixture()
  f.save()
  expect(await f.source.selected({ account: f.account, homePath: f.root, userHome: f.root })).toMatchObject({
    binary: '/fixture/selected-codex', qualificationId: 'storage-isolation', profilePath: f.root,
    generation: 3, isolation: true, status: true, login: true, logout: false,
  })
  const choices = await f.source.discover!(f.binding.target)
  expect(choices.profiles).toEqual(f.record.scope.kind === 'existing-profile' ? [f.record.scope.choice] : [])
  expect(JSON.stringify(choices)).not.toContain(f.root)
  expect(await f.source.registerProfile!({ provider: 'codex', profileRef: f.binding.profileRef,
    qualificationId: f.record.qualificationId, target: f.binding.target })).toEqual({ profileRef: f.binding.profileRef })
  expect((await f.source.resolveProfile!(f.account)).homePath).toBe(f.root)
  await expect(f.source.registerProfile!({ provider: 'codex', profileRef: 'guessed-profile',
    qualificationId: f.record.qualificationId, target: f.binding.target })).rejects.toMatchObject({ code: 'PROVIDER_PROFILE_UNQUALIFIED' })
  f.record.expiresAt = '2000-01-01T00:00:00.000Z'
  f.save()
  expect((await f.source.discover!(f.binding.target)).profiles).toEqual([])
  await expect(f.source.selected({ account: f.account, homePath: f.root, userHome: f.root })).rejects.toMatchObject({
    code: 'PROVIDER_ACCOUNT_UNQUALIFIED',
  })
})

it('rejects changed installation evidence and never substitutes a default executable or profile', async () => {
  const f = fixture()
  f.save()
  f.pin.mockImplementation(() => { throw new Error('The selected installed payload changed') })
  await expect(f.source.selected({ account: f.account, homePath: f.root, userHome: f.root }))
    .rejects.toThrow('selected installed payload changed')
  expect(f.models).not.toHaveBeenCalled()
})

it('retains the persisted qualification generation when installation inventory is recreated', async () => {
  const f = fixture()
  f.save()
  f.pin.mockReturnValue({ ...f.selected, inventoryRevision: 1 })
  const recovered = createProductionAccountSelection({ path: f.path, pin: f.pin,
    managedPaths: () => ({ homePath: f.root, userHome: f.root }), models: f.models })
  expect(await recovered.selected({ account: f.account, homePath: f.root, userHome: f.root }))
    .toMatchObject({ generation: 3, binary: '/fixture/selected-codex' })
  expect((await recovered.discover!(f.binding.target)).generation).toBe(3)
})

it('rejects a model result when its installer qualification changes during discovery', async () => {
  const f = fixture()
  f.save()
  f.models.mockImplementation(async () => {
    f.record.generation++
    f.save()
    return { binding: f.binding, generation: 3, observedAt: '2026-01-01T00:00:00.000Z', models: [] }
  })
  await expect(f.source.models!({ account: f.account, homePath: f.root, userHome: f.root },
    { binding: f.binding, binary: '/fixture/selected-codex', profilePath: f.root,
      qualificationId: f.record.qualificationId, generation: 3, isolation: true, status: true, login: true, logout: false }))
    .rejects.toMatchObject({ code: 'PROVIDER_OBSERVATION_STALE' })
})
