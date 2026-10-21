import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { BYTE_TRANSFER_POLICY, RsyncTransferAuthorizeRequestSchema,
  type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { persistentFixtureRoot } from './helpers/fixtureStorage.js'
import { ResumableByteTransferService } from '../src/modules/byte-transfer/service.js'
import { createMainRsyncEntrypoint, loadWorkerRsyncEntrypoint, readMainRsyncEntrypoint }
  from '../src/modules/byte-transfer/installedEntrypoints.js'
import { InstalledRsyncSelectionSchema } from '../src/modules/byte-transfer/installedRsyncSelection.js'
import { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
const services: ResumableByteTransferService[] = []
const children: ChildProcess[] = []

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child)
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'canonical-recovery-'))
  roots.push(directory)
  const stagingRoot = join(directory, 'stage')
  const root = join(stagingRoot, 'canonical')
  const context: TransferContext = {
    mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(),
  }
  const bytes = Buffer.from('saved bytes')
  const intent: TransferIntent = {
    ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(bytes),
    rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'source',
    sha256: hash(bytes), byteSize: bytes.length, manifestDigest: hash(bytes),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), chunkBytes: 8192,
  }
  const create = () => {
    const service = new ResumableByteTransferService(root, { authorize: async () => {} })
    services.push(service)
    return service
  }
  const original = create()
  await original.start(intent, context)
  await original.append(intent.transferId, context, { offset: 0, bytes, sha256: hash(bytes) })
  const receipt = await original.finish(intent.transferId, context)
  await original.close()
  return { directory, stagingRoot, root, context, intent, bytes, receipt, create }
}

async function owner(f: Awaited<ReturnType<typeof fixture>>, boundary: 'allocation' | 'transfer' | 'reader') {
  const script = `
    import { ResumableByteTransferService } from ${JSON.stringify(
      new URL('../src/modules/byte-transfer/service.ts', import.meta.url).href)};
    const { root, context, intent, receipt, boundary } = JSON.parse(process.argv[1]);
    const pause = async () => {
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    };
    let authorizations = 0;
    const service = new ResumableByteTransferService(root, {
      authorize: async (_intent, _context, operation) => {
        if (boundary === 'allocation' && ++authorizations === 2) await pause();
        if (boundary === 'transfer' && operation === 'status') await pause();
      },
    });
    if (boundary === 'allocation') await service.start(intent, context);
    if (boundary === 'transfer') await service.status(intent.transferId, context);
    if (boundary === 'reader') {
      const reader = await service.openVerified(receipt, context);
      globalThis.reader = reader;
      await pause();
    }
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
    JSON.stringify({ ...f, boundary })], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    let output = ''
    let errors = ''
    const deadline = setTimeout(() => reject(new Error(`Transfer owner did not reach ${boundary}: ${errors}`)), 10_000)
    const ready = () => { clearTimeout(deadline); resolve() }
    const failed = (error: Error) => { clearTimeout(deadline); reject(error) }
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('ready\n')) ready()
    })
    child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    child.once('error', failed)
    child.once('close', code => failed(new Error(errors || `Transfer owner exited ${code}`)))
  })
  return child
}

async function installed(f: Awaited<ReturnType<typeof fixture>>, side: 'main' | 'worker') {
  const binary = join(f.directory, '.local/share/graphql-tools/rsync/3.5.1/bin/rsync')
  const node = join(f.directory, 'node')
  const entryPoint = join(f.directory, 'rsync-writer.mjs')
  await mkdir(dirname(binary), { recursive: true, mode: 0o700 })
  for (const path of [binary, node, entryPoint]) await writeFile(path, 'protected fixture', { mode: 0o500 })
  const sha256 = hash(Buffer.from('protected fixture'))
  const binding: DeviceSessionBinding = { ...f.context, connectionGeneration: 1 }
  const { mainId, deviceId, workerInstallationId, keyRevision, authorizationRevision } = f.context
  const selected = InstalledRsyncSelectionSchema.parse({
    formatVersion: 1, backend: 'rsync', consentRevision: 1,
    registration: { mainId, deviceId, workerInstallationId, keyRevision, authorizationRevision,
      publicKeyFingerprint: sha256, status: 'paired', scopes: ['connect', 'heartbeat'] },
    endpoint: { user: 'worker', host: '100.64.1.1', localRoot: f.stagingRoot, remoteRoot: f.stagingRoot },
    localBinary: { path: binary, sha256, version: '3.5.1' },
    remoteBinary: { path: binary, sha256, version: '3.5.1' },
    nodeBinary: { path: node, sha256 }, entryPoint: { path: entryPoint, sha256 },
    sourceProvenance: { sourceSha256: sha256, releaseSignerFingerprint: 'A'.repeat(40) },
  })
  const path = join(f.directory, 'rsync-selection.json')
  await writeFile(path, JSON.stringify(selected), { mode: 0o600 })
  let denied = false
  const intents = new Map([[f.intent.transferId, f.intent]])
  const register = (intent: TransferIntent) => { intents.set(intent.transferId, intent) }
  const authorize = async () => { if (denied) throw new Error('Transfer authority revoked') }
  if (side === 'worker') {
    const loaded = await loadWorkerRsyncEntrypoint({
      path, entryPoint, pairing: binding as unknown as WorkerPairingConfiguration,
      current: () => binding, ownership: () => undefined,
      request: async payload => {
        await authorize()
        return { payload: intents.get(RsyncTransferAuthorizeRequestSchema.parse(payload).transferId) }
      },
    })
    if (loaded.kind !== 'configured') throw new Error('Protected worker entrypoint unavailable')
    services.push(loaded.providers.receiver)
    return { receiver: loaded.providers.receiver, register, deny: () => { denied = true } }
  }
  const installation = await readMainRsyncEntrypoint(path)
  if (installation.kind !== 'configured') throw new Error('Protected Main entrypoint unavailable')
  const endpoint = new DeviceEndpoint({
    mainId: binding.mainId, appVersion: 'fixture',
    auth: { authenticateDevice: vi.fn(), revalidateDevice: vi.fn() },
    signMainIdentityProof: vi.fn(), reconcile: vi.fn(), presence: vi.fn(),
  })
  vi.spyOn(endpoint, 'captureRequest').mockReturnValue({ binding, request: async () => ({ payload: f.intent }) })
  const loaded = createMainRsyncEntrypoint({
    installation, endpoint: () => endpoint, ownership: () => undefined,
    accepted: { intent: async id => {
      const intent = intents.get(id)
      if (!intent) throw new Error('Transfer not accepted')
      return intent
    }, authorize },
    setup: { checkAcceptedTransfer: vi.fn(), readAcceptedTransfer: vi.fn() },
  })
  services.push(loaded.providers.receiver)
  return { receiver: loaded.providers.receiver, register, deny: () => { denied = true } }
}

describe('canonical transfer ownership recovery', () => {
  it('recovers a dead allocation owner and admits an unrelated transfer without losing saved bytes', async () => {
    const f = await fixture()
    const child = await owner(f, 'allocation')
    await stop(child)
    const restarted = f.create()
    await expect(restarted.start({ ...f.intent, transferId: randomUUID() }, f.context))
      .resolves.toMatchObject({ durableOffset: 0 })
    expect(await restarted.resolveVerifiedReceipt(f.intent.transferId, f.context)).toEqual(f.receipt)
  })

  it('recovers a dead transfer owner and reads back the original committed bytes and receipt', async () => {
    const f = await fixture()
    const child = await owner(f, 'transfer')
    await stop(child)
    const restarted = f.create()
    expect(await restarted.status(f.intent.transferId, f.context)).toMatchObject({ durableOffset: f.bytes.length })
    expect(await restarted.finish(f.intent.transferId, f.context)).toEqual(f.receipt)
    const reader = await restarted.openVerified(f.receipt, f.context)
    const chunks: Buffer[] = []
    for await (const chunk of reader) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(f.bytes)
  })

  it('releases a dead reader charge before admitting the full per-device staging budget', async () => {
    const f = await fixture()
    const child = await owner(f, 'reader')
    await stop(child)
    const restarted = f.create()
    await restarted.retire(f.intent.transferId)
    for (let index = 0; index < 2; index++) {
      await expect(restarted.start({ ...f.intent, transferId: randomUUID(),
        byteSize: BYTE_TRANSFER_POLICY.maxStagingPerDeviceBytes / 2 }, f.context)).resolves.toBeDefined()
    }
  })

  it.each(['allocation', 'transfer'] as const)('preserves a live %s owner across service instances', async boundary => {
    const f = await fixture()
    const child = await owner(f, boundary)
    const restarted = f.create()
    const read = boundary === 'allocation'
      ? restarted.start({ ...f.intent, transferId: randomUUID() }, f.context)
      : restarted.status(f.intent.transferId, f.context)
    await expect(read).rejects.toThrow()
    expect(child.exitCode).toBeNull()
    await stop(child)
    await expect(restarted.status(f.intent.transferId, f.context)).resolves.toBeDefined()
  })

  it('retains accounting while the original reader process still owns an open descriptor', async () => {
    const f = await fixture()
    const child = await owner(f, 'reader')
    const restarted = f.create()
    await restarted.retire(f.intent.transferId)
    await restarted.start({ ...f.intent, transferId: randomUUID(),
      byteSize: BYTE_TRANSFER_POLICY.maxStagingPerDeviceBytes / 2 }, f.context)
    await expect(restarted.start({ ...f.intent, transferId: randomUUID(),
      byteSize: BYTE_TRANSFER_POLICY.maxStagingPerDeviceBytes / 2 }, f.context)).rejects.toThrow('quota')
    expect(child.exitCode).toBeNull()
    await stop(child)
    await restarted.retire(f.intent.transferId)
  })

  it('refuses to recover a replaced dead-owner lock directory', async () => {
    const f = await fixture()
    const child = await owner(f, 'transfer')
    await stop(child)
    const lock = join(f.root, `${f.intent.transferId}.lock`)
    await rename(lock, join(f.root, 'retained-owner-lock'))
    await mkdir(lock, { mode: 0o700 })
    await expect(f.create().status(f.intent.transferId, f.context)).rejects.toThrow()
  })
})

describe.each(['main', 'worker'] as const)('installed %s canonical recovery', side => {
  it.each(['allocation', 'transfer', 'reader'] as const)(
    'reconciles a dead %s owner and preserves current authorization', async boundary => {
      const f = await fixture()
      const child = await owner(f, boundary)
      await stop(child)
      const loaded = await installed(f, side)
      if (boundary === 'reader') {
        await loaded.receiver.retire(f.intent.transferId)
        for (let index = 0; index < 2; index++) {
          const intent = { ...f.intent, transferId: randomUUID(),
            byteSize: BYTE_TRANSFER_POLICY.maxStagingPerDeviceBytes / 2 }
          loaded.register(intent)
          await loaded.receiver.start(intent, f.context)
        }
      } else {
        expect(await loaded.receiver.resolveVerifiedReceipt(f.intent.transferId, f.context)).toEqual(f.receipt)
      }
      loaded.deny()
      await expect(loaded.receiver.start(f.intent, f.context)).rejects.toThrow('Transfer authority revoked')
    },
  )
})
