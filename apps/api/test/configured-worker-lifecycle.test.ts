import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) =>
    args[0] instanceof URL && args[0].pathname.endsWith('/apps/worker/manifest.json')
      ? JSON.stringify({ version: '0.1.0' }) : actual.readFile(...args) }
})
vi.mock('../../worker/src/diagnostics.mjs', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, hostFacts: async () => ({
    rootPersistent: true, homePersistent: true, storagePersistent: true,
  }) }
})
vi.mock('../../worker/src/installation.mjs', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, validateManifest: vi.fn(), requireReleaseState: vi.fn() }
})
vi.mock('../../worker/src/rootExtension.mjs', () => ({ approvedRootExtensions: async () => [] }))
vi.mock('../src/modules/harnesses/workerMcpInstallation.ts', () => ({
  registerWorkerMcpInstallation: vi.fn(),
}))
vi.mock('../src/modules/runs/remote/workerComposition.ts', () => ({
  createWorkerExecutionDomains: () => ({ extensions: [], close: async () => {} }),
}))
vi.mock('../src/modules/devices/deviceCarrier.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/modules/devices/deviceCarrier.js')>()
  return { ...actual, deviceConnector: () => async (signal: AbortSignal) => new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) }
})

const identityPath = new URL('../../../packages/contracts/src/deviceIdentityNode.ts', import.meta.url).href
const { loadOrCreateWorkerIdentity, persistWorkerPairing } = await import(identityPath)
const factoryPath = new URL('../../worker/src/workerFactory.mjs', import.meta.url).href
const { startConfiguredWorker } = await import(factoryPath)
const runtimePath = new URL('../../worker/src/runtime.mjs', import.meta.url).href
const { readWorkerStatus } = await import(runtimePath)

it('starts and stops the configured device connection and releases its Worker installation for restart', async () => {
  const stateDirectory = await privateFixtureDirectory('configured-worker-lifecycle-')
  try {
    const identity = await loadOrCreateWorkerIdentity(stateDirectory)
    await persistWorkerPairing(stateDirectory, {
      formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: identity.workerInstallationId, keyRevision: identity.keyRevision,
      authorizationRevision: 1, endpoint: 'wss://worker.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00Z',
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const worker = await startConfiguredWorker({ stateDirectory, executionDomains: {} })
      try {
        expect(worker.connection.status()).toMatchObject({ desired: true, phase: 'connecting', generation: 1 })
        expect(await readWorkerStatus(stateDirectory)).toMatchObject({
          active: true, phase: 'connecting', workerInstallationId: identity.workerInstallationId,
        })
      } finally {
        await worker.stop()
      }
      expect(worker.connection.status()).toMatchObject({ desired: false, phase: 'disconnected' })
      expect(await readWorkerStatus(stateDirectory)).toBeNull()
      await worker.stop()
    }
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
