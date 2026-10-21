import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../errors.js'
import { BrowserSnapshotKeyStore, unwrapBrowserSnapshotKey, type BrowserInstallationBinding,
  type BrowserPairingAuthority } from './keys.js'
import type { BrowserSnapshotIdentity } from './types.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function pairingFixture() {
  const source: BrowserInstallationBinding = { computerId: 'main', installationId: 'main-installation', connectionId: 'main-connection' }
  const recipient: BrowserInstallationBinding = { computerId: 'worker', installationId: 'worker-installation', connectionId: 'worker-connection' }
  const bindings = new Map([['main', source], ['worker', recipient]])
  const wrappingKeys = new Map([['main', new Uint8Array(32).fill(11)], ['worker', new Uint8Array(32).fill(22)]])
  const authority: BrowserPairingAuthority = {
    current: vi.fn(async computerId => {
      const binding = bindings.get(computerId)
      if (!binding) throw new DomainError('BROWSER_PAIRING_CHANGED', 'Computer is no longer paired.', 403)
      return { ...binding }
    }),
    assertCurrent: vi.fn(async binding => {
      const current = bindings.get(binding.computerId)
      if (!current || current.installationId !== binding.installationId || current.connectionId !== binding.connectionId) {
        throw new DomainError('BROWSER_PAIRING_CHANGED', 'Paired connection changed.', 403)
      }
    }),
    assertInstallation: vi.fn(async (computerId, installationId) => {
      if (bindings.get(computerId)?.installationId !== installationId) throw new DomainError('BROWSER_PAIRING_CHANGED', 'Installation changed.', 403)
    }),
    wrappingKey: vi.fn(async binding => {
      await authority.assertCurrent(binding)
      return wrappingKeys.get(binding.computerId)!.slice()
    }),
  }
  return { source, recipient, bindings, authority }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'foreman-browser-keys-'))
  directories.push(directory)
  const pairing = pairingFixture()
  return { ...pairing, directory, store: new BrowserSnapshotKeyStore(directory, pairing.authority) }
}

const snapshot = (publishedRevision = 1): BrowserSnapshotIdentity => ({ profileId: 'profile', publishedRevision,
  sha256: String(publishedRevision).repeat(64), format: 'cookies-localstorage-v1' })

it('keeps a publication key stable across allocation/seal retries and store reopen while sealing one immutable ciphertext identity', async () => {
  const { directory, store, source, recipient, authority } = await fixture()
  const request = { profileId: 'profile', publishedRevision: 1, operationId: 'publish-1', source, stateHash: 'a'.repeat(64) }
  const keyId = await store.allocate(request)
  const before = await unwrapBrowserSnapshotKey(await store.envelope(request.operationId, source), source, authority)
  expect(before).toHaveLength(32)
  await store.seal(request.operationId, snapshot())
  await store.seal(request.operationId, snapshot())
  const reopened = new BrowserSnapshotKeyStore(directory, authority)
  expect(await reopened.allocate(request)).toBe(keyId)
  const first = await reopened.snapshotEnvelope(snapshot(), recipient), repeated = await reopened.snapshotEnvelope(snapshot(), recipient)
  expect(first).toMatchObject({ keyId, snapshot: snapshot(), recipient })
  expect(await unwrapBrowserSnapshotKey(first, recipient, authority)).toEqual(before)
  expect(await unwrapBrowserSnapshotKey(repeated, recipient, authority)).toEqual(before)
  expect(first.encrypted).not.toEqual(repeated.encrypted)
  await expect(reopened.seal(request.operationId, { ...snapshot(), sha256: 'f'.repeat(64) }))
    .rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' })
  await expect(reopened.allocate({ ...request, stateHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
})

it('allocates a fresh independent data key for each publication and never provides an unsealed key to a destination', async () => {
  const { store, source, recipient, authority } = await fixture()
  const first = { profileId: 'profile', publishedRevision: 1, operationId: 'first', source, stateHash: 'a'.repeat(64) }
  const second = { ...first, publishedRevision: 2, operationId: 'second', stateHash: 'b'.repeat(64) }
  const keyId = await store.allocate(first), nextId = await store.allocate(second)
  expect(nextId).not.toBe(keyId)
  const key = await unwrapBrowserSnapshotKey(await store.envelope('first', source), source, authority)
  const next = await unwrapBrowserSnapshotKey(await store.envelope('second', source), source, authority)
  expect(next).not.toEqual(key)
  await expect(store.envelope('first', recipient)).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' })
})

it('rejects changed recipient/source installations and rechecks the live connection before returning a key envelope', async () => {
  const { store, source, recipient, authority, bindings } = await fixture()
  await store.allocate({ profileId: 'profile', publishedRevision: 1, operationId: 'publish', source, stateHash: 'a'.repeat(64) })
  await store.seal('publish', snapshot())
  const envelope = await store.snapshotEnvelope(snapshot(), recipient)
  const replacement = { ...recipient, installationId: 'replacement-installation', connectionId: 'new-connection' }
  bindings.set(recipient.computerId, replacement)
  await expect(store.snapshotEnvelope(snapshot(), recipient)).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
  await expect(unwrapBrowserSnapshotKey(envelope, replacement, authority)).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
  bindings.set(recipient.computerId, recipient)
  vi.mocked(authority.wrappingKey).mockImplementationOnce(async binding => {
    await authority.assertCurrent(binding)
    bindings.set(binding.computerId, { ...binding, connectionId: 'changed-during-request' })
    return new Uint8Array(32).fill(22)
  })
  await expect(store.snapshotEnvelope(snapshot(), recipient)).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
  bindings.set(recipient.computerId, recipient)
  bindings.set(source.computerId, { ...source, installationId: 'new-main-installation' })
  await expect(store.snapshotEnvelope(snapshot(), recipient)).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
  await expect(unwrapBrowserSnapshotKey(envelope, recipient, authority)).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
})

it('authenticates both encrypted key bytes and their exact profile/snapshot metadata before unwrap', async () => {
  const { store, source, recipient, authority } = await fixture()
  await store.allocate({ profileId: 'profile', publishedRevision: 1, operationId: 'publish', source, stateHash: 'a'.repeat(64) })
  await store.seal('publish', snapshot())
  const envelope = await store.snapshotEnvelope(snapshot(), recipient)
  const tampered = new Uint8Array(envelope.encrypted); tampered[15] = tampered[15]! ^ 1
  await expect(unwrapBrowserSnapshotKey({ ...envelope, encrypted: tampered }, recipient, authority)).rejects.toThrow()
  await expect(unwrapBrowserSnapshotKey({ ...envelope, stateHash: 'c'.repeat(64) }, recipient, authority)).rejects.toThrow()
  await expect(unwrapBrowserSnapshotKey({ ...envelope, snapshot: { ...snapshot(), sha256: 'd'.repeat(64) } }, recipient, authority)).rejects.toThrow()
  expect(await unwrapBrowserSnapshotKey(envelope, recipient, authority)).toHaveLength(32)
})
