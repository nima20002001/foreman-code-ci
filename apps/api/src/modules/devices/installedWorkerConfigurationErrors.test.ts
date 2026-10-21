import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { COMPUTER_ACCOUNTS_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'
import { DomainError } from '../errors.js'

const probes = vi.hoisted(() => ({ read: vi.fn(), accounts: vi.fn(), maintenance: vi.fn() }))
vi.mock('../runs/remote/installedWorkflowConfiguration.js', async importOriginal => ({
  ...await importOriginal<object>(), readInstalledWorkflowConfiguration: probes.read,
}))
vi.mock('../harnesses/installedWorkerManagedMcp.js', () => ({
  createInstalledWorkerManagedMcp: () => ({ worker: {}, ensureReady: async () => {} }),
}))
vi.mock('../runs/remote/installedWorkflowHost.js', () => ({
  createInstalledWorkflowHost: async () => ({ kind: 'unavailable' }),
}))
vi.mock('../computers/accountProbe.js', () => ({
  systemPorts: () => ({}), probeComputerAccounts: probes.accounts,
}))
vi.mock('../computers/maintenance.js', () => ({
  systemMaintenancePorts: () => ({}), ComputerMaintenance: class {
    status = probes.maintenance
  },
}))

it.each([COMPUTER_ACCOUNTS_NAMESPACE, COMPUTER_MAINTENANCE_NAMESPACE])(
  'propagates a configured selection read failure through %s', async namespace => {
    vi.clearAllMocks()
    probes.read.mockResolvedValue(null)
    probes.accounts.mockResolvedValue({ observedAt: new Date().toISOString(), accounts: [] })
    probes.maintenance.mockResolvedValue({ observedAt: new Date().toISOString(), harnesses: [], tasks: [],
      system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } })
    const storage = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(storage, { recursive: true })
    const stateDirectory = await mkdtemp(join(storage, 'worker-selection-'))
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
      deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
      credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
    const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
      workerInstallationId: pairing.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    const mounted = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
      configuration: { path: join(stateDirectory, 'selection.json'), ownerUid: process.getuid!() },
      approvedRoots: async () => null, codexSuiteRevision: 'selection-test',
      connection: () => ({ currentBinding: () => binding, captureRequest: () => undefined, mainNow: () => Date.now() }) })
    try {
      probes.read.mockRejectedValue(new DomainError('WORKER_WORKFLOW_UNAVAILABLE',
        'The installed workflow selection is unavailable.', 409))
      const extension = mounted.extensions.find(value => value.namespace === namespace)!
      const request = { operation: namespace === COMPUTER_ACCOUNTS_NAMESPACE ? 'read' : 'status' }
      await expect(extension.handle!(request, { binding, signal: AbortSignal.timeout(1000) }))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      expect(probes.accounts).not.toHaveBeenCalled()
      expect(probes.maintenance).not.toHaveBeenCalled()
    } finally {
      await mounted.close()
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
