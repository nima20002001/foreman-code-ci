import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rename, rm, writeFile, unlink, readFile, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { DeviceSessionBindingSchema } from '@foreman-code/contracts/device-connection'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { createInstalledNativeOutputStorage, assertNativeOutputRootExcluded, createNativeOutputBudgetLedger,
  type InstalledNativeOutputStorageInput, type RemoteNativeOutputStorageOwner,
  type LocalNativeOutputStorageOwner } from './installedNativeOutputStorage.js'
import { openPrivateRoot, withPrivateDirectoryLock } from '../../sources/privateFilesystem.js'
import { deferred } from '../../../../test/helpers/deferred.js'

const roots: string[] = []
const processes: ChildProcess[] = []
afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGKILL')
      await closed
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp('/tmp/native-output-storage-'); roots.push(root)
  const rootDirectory = join(root, 'private'); await mkdir(rootDirectory, { mode: 0o700 })
  const mainId = randomUUID()
  const intent = DispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId, runId: 'run', nodeId: 'node',
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt',
    operationId: 'operation', bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } })
  const binding = DeviceSessionBindingSchema.parse({ mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 })
  const limits = { maxDiskBytes: MAX_FILE_BYTES, maxSnapshotBytes: MAX_FILE_BYTES, maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords }
  const release = vi.fn(async () => {}), reservationCurrent = vi.fn(async () => {})
  // Contract doubles only. These do not establish actual native qualification or
  // a production durable ledger; the adapter must require their real providers.
  const input: InstalledNativeOutputStorageInput & { owner: RemoteNativeOutputStorageOwner } = { rootDirectory,
    owner: { intent, binding, session: { harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'native-session' },
      nativeTurnId: 'original-turn', runtimeGeneration: 1 }, limits,
    assertCurrent: vi.fn(async () => {}),
    protection: { assertProtected: vi.fn(async () => {}), assertQuiescent: vi.fn(async () => {}) },
    budget: { reserve: vi.fn(async () => ({ assertCurrent: reservationCurrent, release })) } }
  return { root, input, release, reservationCurrent, request: { artifactId: randomUUID(), ...limits } }
}

async function budgetFixture() {
  const f = await fixture()
  const rootDirectory = join(f.root, 'budget')
  await mkdir(rootDirectory, { mode: 0o700 })
  const { binding } = f.input.owner
  const input = { rootDirectory, installation: { mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId },
    limits: { maxDiskBytes: 8, maxSnapshotBytes: 8, maxCommandRecords: 8 }, initializeNewStore: true as const }
  const reservation = { owner: f.input.owner, limits: input.limits,
    requested: { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 } }
  return { ...f, budgetInput: input, reservation }
}

function ledgerProcess(script: string, input: unknown) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(input)],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  const started = deferred()
  let output = ''
  let errors = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    if (output.includes('ready\n')) started.resolve()
  })
  child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8') })
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(errors || `Ledger process exited ${code}`)))
  })
  return { child, started: Promise.race([started.promise, completed]), completed }
}

describe('explicit qualified native storage adapter, no native acceptance', () => {
  it('never substitutes directory mode for qualification or reserves after denial', async () => {
    const f = await fixture()
    vi.mocked(f.input.protection.assertProtected).mockRejectedValue(new Error('No actual qualification'))
    await expect(createInstalledNativeOutputStorage(f.input)).rejects.toThrow('No actual qualification')
    expect(f.input.budget.reserve).not.toHaveBeenCalled()
  })
  it('passes exact original identity and aggregate caps to the durable provider', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    const reservation = await storage.reserve(f.request)
    expect(f.input.budget.reserve).toHaveBeenCalledWith({ owner: f.input.owner,
      artifactId: f.request.artifactId, limits: f.input.limits,
      requested: f.input.limits }, undefined)
    await reservation.assertCurrent()
    expect(f.reservationCurrent).toHaveBeenCalledTimes(2)
    await expect(storage.reserve({ ...f.request, maxDiskBytes: MAX_FILE_BYTES + 1 })).rejects.toThrow()
    expect(f.input.budget.reserve).toHaveBeenCalledTimes(1)
  })
  it('retains the original reservation when protection changes after admission', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    vi.mocked(f.input.budget.reserve).mockImplementationOnce(async () => {
      vi.mocked(f.input.protection.assertProtected).mockRejectedValue(new Error('Original owner changed'))
      return { assertCurrent: f.reservationCurrent, release: f.release }
    })
    await expect(storage.reserve(f.request)).rejects.toThrow('Original owner changed')
    expect(f.release).not.toHaveBeenCalled()
  })
  it('rejects retargeted private roots before reserving or releasing', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    const reservation = await storage.reserve(f.request)
    await rename(f.input.rootDirectory, join(f.root, 'original'))
    await mkdir(f.input.rootDirectory, { mode: 0o700 })
    await expect(reservation.assertCurrent()).rejects.toThrow()
    await expect(reservation.release()).rejects.toThrow()
    expect(f.release).not.toHaveBeenCalled()
  })
  it('releases only absent bytes with positive original writer/reader closure; retry survives withdrawal', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    const reservation = await storage.reserve(f.request), path = join(f.input.rootDirectory, f.request.artifactId)
    await writeFile(path, 'owned bytes', { mode: 0o600 })
    await expect(reservation.release()).rejects.toThrow()
    expect(f.release).not.toHaveBeenCalled()
    await unlink(path)
    vi.mocked(f.input.protection.assertQuiescent).mockRejectedValueOnce(new Error('Reader still active'))
    await expect(reservation.release()).rejects.toThrow('Reader still active')
    expect(f.release).not.toHaveBeenCalled()
    vi.mocked(f.input.assertCurrent).mockRejectedValue(new Error('Turn withdrawn'))
    await reservation.release()
    expect(f.release).toHaveBeenCalledTimes(1)
  })
  it('rejects writable parents, descendants, same directory and relative paths', () => {
    for (const roots of [['/'], ['/private'], ['/private/output'], ['/private/output/child'], ['relative']]) {
      expect(() => assertNativeOutputRootExcluded('/private/output', roots)).toThrow()
    }
    expect(() => assertNativeOutputRootExcluded('/private/output', ['/workspace', '/tmp'])).not.toThrow()
  })
})

describe('durable native output installation budget, no qualification grants', () => {
  it('serializes simultaneous initialization, reservations and releases across independent turns', async () => {
    const f = await budgetFixture()
    const ledgers = await Promise.all(Array.from({ length: 4 }, () => createNativeOutputBudgetLedger(f.budgetInput)))
    const allocations = ledgers.map((_ledger, index) => ({ ...f.reservation, artifactId: randomUUID(),
      owner: { ...f.reservation.owner, nativeTurnId: `turn-${index}` },
      requested: { maxDiskBytes: 2, maxSnapshotBytes: 2, maxCommandRecords: 2 } }))
    const reservations = await Promise.all(ledgers.map((ledger, index) => ledger.reserve(allocations[index]!)))
    await Promise.all(reservations.map(reservation => reservation.assertCurrent()))
    await expect(ledgers[0]!.reserve({ ...f.reservation, artifactId: randomUUID() }))
      .rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_STORAGE_UNAVAILABLE' })
    const recovered = await Promise.all(allocations.map(async allocation => {
      const ledger = await createNativeOutputBudgetLedger(f.budgetInput)
      return ledger.reserve(allocation)
    }))
    await Promise.all([...reservations, ...recovered].map(reservation => reservation.release()))
    await Promise.all(reservations.map(reservation => expect(reservation.assertCurrent()).rejects.toThrow()))
    const full = await ledgers[0]!.reserve({ ...f.reservation, artifactId: randomUUID(), requested: f.budgetInput.limits })
    await full.assertCurrent()
    await full.release()
  }, 30_000)

  it('waits for a live operation across processes, then preserves all concurrent charges and releases', async () => {
    const f = await budgetFixture()
    const root = await openPrivateRoot(f.budgetInput.rootDirectory)
    const entered = deferred()
    const resume = deferred()
    const marker = join(f.budgetInput.rootDirectory, '.native-output-budget.lock')
    const holding = withPrivateDirectoryLock(root, async () => {
      await mkdir(marker, { mode: 0o700 })
      entered.resolve()
      await resume.promise
      await rmdir(marker)
    })
    await entered.promise
    const script = `
      import { randomUUID } from 'node:crypto';
      const { createNativeOutputBudgetLedger } = await import(${JSON.stringify(new URL('./installedNativeOutputStorage.ts', import.meta.url).href)});
      const { budgetInput, reservation } = JSON.parse(process.argv[1]);
      console.log('ready');
      const ledger = await createNativeOutputBudgetLedger(budgetInput);
      const reservations = await Promise.all(Array.from({ length: 4 }, (_, index) => ledger.reserve({
        ...reservation, artifactId: randomUUID(), owner: { ...reservation.owner, nativeTurnId: 'process-turn-' + index }
      })));
      await Promise.all(reservations.map(reservation => reservation.assertCurrent()));
      await Promise.all(reservations.map(reservation => reservation.release()));
    `
    const child = ledgerProcess(script, { budgetInput: f.budgetInput, reservation: f.reservation })
    const childResult = expect(child.completed).resolves.toBeUndefined()
    const local = createNativeOutputBudgetLedger(f.budgetInput).then(async ledger => {
      const reservations = await Promise.all(Array.from({ length: 4 }, (_, index) => ledger.reserve({
        ...f.reservation, artifactId: randomUUID(), owner: { ...f.reservation.owner, nativeTurnId: `local-turn-${index}` },
      })))
      await Promise.all(reservations.map(reservation => reservation.assertCurrent()))
      await Promise.all(reservations.map(reservation => reservation.release()))
      return ledger
    })
    const localResult = expect(local).resolves.toBeDefined()
    try {
      await child.started
      await delay(50)
    } finally {
      resume.resolve()
      await holding
      await root.close()
    }
    await Promise.all([childResult, localResult])
    const ledger = await local
    const full = await ledger.reserve({ ...f.reservation, artifactId: randomUUID(), requested: f.budgetInput.limits })
    await full.assertCurrent()
    await full.release()
  }, 30_000)

  it('cancels a queued reservation without changing an existing charge', async () => {
    const f = await budgetFixture()
    const ledger = await createNativeOutputBudgetLedger(f.budgetInput)
    const original = await ledger.reserve({ ...f.reservation, artifactId: randomUUID() })
    const root = await openPrivateRoot(f.budgetInput.rootDirectory)
    const entered = deferred()
    const resume = deferred()
    const holding = withPrivateDirectoryLock(root, async () => { entered.resolve(); await resume.promise })
    await entered.promise
    const stop = new AbortController()
    const waiting = ledger.reserve({ ...f.reservation, artifactId: randomUUID() }, stop.signal)
    const rejected = expect(waiting).rejects.toThrow()
    try {
      await delay(25)
      stop.abort(new Error('Turn stopped while waiting'))
      await rejected
    } finally {
      resume.resolve()
      await holding
      await root.close()
    }
    await original.assertCurrent()
    const remainder = await ledger.reserve({ ...f.reservation, artifactId: randomUUID(),
      requested: { maxDiskBytes: 7, maxSnapshotBytes: 7, maxCommandRecords: 7 } })
    await Promise.all([original.release(), remainder.release()])
  }, 30_000)

  it('retains a killed process marker and its original reservation on recovery', async () => {
    const f = await budgetFixture()
    const ledger = await createNativeOutputBudgetLedger(f.budgetInput)
    const allocation = { ...f.reservation, artifactId: randomUUID(), requested: f.budgetInput.limits }
    const original = await ledger.reserve(allocation)
    const script = `
      import { mkdir } from 'node:fs/promises';
      import { join } from 'node:path';
      const { openPrivateRoot, withPrivateDirectoryLock } = await import(${JSON.stringify(new URL('../../sources/privateFilesystem.ts', import.meta.url).href)});
      const { rootDirectory } = JSON.parse(process.argv[1]);
      const root = await openPrivateRoot(rootDirectory);
      await withPrivateDirectoryLock(root, async () => {
        await mkdir(join(rootDirectory, '.native-output-budget.lock'), { mode: 0o700 });
        console.log('ready');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `
    const child = ledgerProcess(script, f.budgetInput)
    const exited = expect(child.completed).rejects.toThrow()
    await child.started
    child.child.kill('SIGKILL')
    await exited
    await expect(createNativeOutputBudgetLedger(f.budgetInput)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(original.release()).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(ledger.reserve({ ...f.reservation, artifactId: randomUUID() })).rejects.toMatchObject({ code: 'EEXIST' })
    // A reconciler can remove the marker only after confirming that original operation stopped.
    await rmdir(join(f.budgetInput.rootDirectory, '.native-output-budget.lock'))
    const recovered = await createNativeOutputBudgetLedger(f.budgetInput)
    await (await recovered.reserve(allocation)).assertCurrent()
    await expect(recovered.reserve({ ...f.reservation, artifactId: randomUUID() })).rejects.toThrow()
    await original.release()
  }, 30_000)

  it.each([0, 1])('recovers local generation %s and rejects changed installation or generation', async (runtimeGeneration) => {
    const f = await budgetFixture()
    const installation = { kind: 'local' as const, mainId: f.input.owner.intent.mainId }
    const owner: LocalNativeOutputStorageOwner = { kind: 'local', mainId: installation.mainId,
      executionId: 'local-execution', attemptId: 'local-attempt', placementHash: 'a'.repeat(64),
      session: f.input.owner.session, nativeTurnId: 'local-turn', runtimeGeneration }
    const input = { ...f.budgetInput, installation }
    const ledger = await createNativeOutputBudgetLedger(input)
    const allocation = { ...f.reservation, owner, artifactId: randomUUID() }
    const storage = await createInstalledNativeOutputStorage({ ...f.input, owner, limits: input.limits, budget: ledger })
    const original = await storage.reserve({ artifactId: allocation.artifactId, ...allocation.requested })
    const recovered = await createNativeOutputBudgetLedger(input)
    const recoveredStorage = await createInstalledNativeOutputStorage({ ...f.input, owner,
      limits: input.limits, budget: recovered })
    await (await recoveredStorage.reserve({ artifactId: allocation.artifactId, ...allocation.requested })).assertCurrent()
    await expect(recovered.reserve({ ...allocation, owner: { ...owner, runtimeGeneration: runtimeGeneration + 1 } }))
      .rejects.toThrow()
    await expect(recovered.reserve({ ...allocation, owner: { ...owner, mainId: randomUUID() } })).rejects.toThrow()
    await expect(recovered.reserve({ ...allocation, owner: f.input.owner })).rejects.toThrow()
    await expect(createInstalledNativeOutputStorage({ ...f.input, owner: { ...owner, runtimeGeneration: -1 },
      limits: input.limits, budget: recovered })).rejects.toThrow()
    await expect(createNativeOutputBudgetLedger(f.budgetInput)).rejects.toThrow()
    await original.release()
    await expect(original.assertCurrent()).rejects.toThrow()
  })

  it('recovers the original installed transport generation zero after reservation acceptance', async () => {
    const f = await budgetFixture()
    const owner = { ...f.input.owner, runtimeGeneration: 0 }
    const allocation = { ...f.reservation, owner, artifactId: randomUUID() }
    const ledger = await createNativeOutputBudgetLedger(f.budgetInput)
    const storage = await createInstalledNativeOutputStorage({ ...f.input, owner,
      limits: f.budgetInput.limits, budget: ledger })
    const original = await storage.reserve({ artifactId: allocation.artifactId, ...allocation.requested })
    const recovered = await createNativeOutputBudgetLedger(f.budgetInput)
    const restored = await createInstalledNativeOutputStorage({ ...f.input, owner,
      limits: f.budgetInput.limits, budget: recovered })
    await (await restored.reserve({ artifactId: allocation.artifactId, ...allocation.requested })).assertCurrent()
    await expect(recovered.reserve({ ...allocation, owner: { ...owner, runtimeGeneration: 1 } })).rejects.toThrow()
    await expect(recovered.reserve({ ...allocation, owner: { ...owner, nativeTurnId: 'another-turn' } })).rejects.toThrow()
    await expect(createInstalledNativeOutputStorage({ ...f.input, owner: { ...owner, runtimeGeneration: -1 } }))
      .rejects.toThrow()
    await original.release()
    await expect(original.assertCurrent()).rejects.toThrow()
  })

  it('recovers exact reservations and enforces aggregate caps across turns and ledger instances', async () => {
    const f = await fixture(), owner = f.input.owner, binding = owner.binding
    const rootDirectory = join(f.root, 'budget'); await mkdir(rootDirectory, { mode: 0o700 })
    const installation = { mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId }
    const limits = { maxDiskBytes: 8, maxSnapshotBytes: 8, maxCommandRecords: 2 }
    const requested = { maxDiskBytes: 6, maxSnapshotBytes: 6, maxCommandRecords: 1 }
    const ledger = await createNativeOutputBudgetLedger({ rootDirectory, installation, limits, initializeNewStore: true })
    const original = { artifactId: randomUUID(), owner, limits, requested }
    const reservation = await ledger.reserve(original)
    const before = await readFile(join(rootDirectory, '.native-output-budget.json'), 'utf8')
    const recovered = await createNativeOutputBudgetLedger({ rootDirectory, installation, limits })
    await (await recovered.reserve(original)).assertCurrent()
    expect(await readFile(join(rootDirectory, '.native-output-budget.json'), 'utf8')).toBe(before)
    await expect(recovered.reserve({ ...original, artifactId: randomUUID(), owner: { ...owner, nativeTurnId: 'another-turn' } })).rejects.toThrow()
    await expect(recovered.reserve({ ...original, owner: { ...owner, nativeTurnId: 'foreign-turn' } })).rejects.toThrow()
    await reservation.release(); await reservation.release()
    await expect(reservation.assertCurrent()).rejects.toThrow()
    await recovered.reserve({ ...original, artifactId: randomUUID() })
  })
  it('never initializes over pre-existing residue or steals a crash-left lock', async () => {
    const f = await fixture(), binding = f.input.owner.binding, rootDirectory = join(f.root, 'budget')
    await mkdir(rootDirectory, { mode: 0o700 })
    const input = { rootDirectory, installation: { mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId },
      limits: { maxDiskBytes: 8, maxSnapshotBytes: 8, maxCommandRecords: 2 } }
    await expect(createNativeOutputBudgetLedger(input)).rejects.toMatchObject({ code: 'ENOENT' })
    const residue = join(rootDirectory, 'unreconciled'); await writeFile(residue, 'original bytes', { mode: 0o600 })
    await expect(createNativeOutputBudgetLedger({ ...input, initializeNewStore: true })).rejects.toThrow()
    await unlink(residue)
    const ledger = await createNativeOutputBudgetLedger({ ...input, initializeNewStore: true })
    await mkdir(join(rootDirectory, '.native-output-budget.lock'), { mode: 0o700 })
    await expect(ledger.reserve({ owner: f.input.owner, artifactId: randomUUID(), limits: input.limits,
      requested: { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 } })).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
