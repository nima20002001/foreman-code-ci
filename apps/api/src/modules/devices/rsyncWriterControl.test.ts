import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { RsyncControlResponseSchema, TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { RsyncWriterOwnership } from '../byte-transfer/rsyncWriterOwnership.js'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import { readRecord } from '../harnesses/recovery/storage.js'
import { createWorkerRsyncWriterControl } from './rsyncWriterControl.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp('/tmp/graphql-w07-writers-'); roots.push(root)
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  let current: DeviceSessionBinding | undefined = binding, denied = false
  const intent = TransferIntentSchema.parse({ ...transferContextForBinding(binding), version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1,
    direction: 'to-worker', byteClass: 'source', sha256: 'b'.repeat(64), byteSize: 8, manifestDigest: 'c'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), chunkBytes: 8 })
  const binary = { executable: join(root, 'installed-rsync'), sha256: createHash('sha256').update('installed bytes').digest('hex') }
  await writeFile(binary.executable, 'installed bytes', { mode: 0o500 })
  const ownership = new RsyncWriterOwnership(root, () => current)
  const accepted = { intent: vi.fn(async () => structuredClone(intent)), authorize: vi.fn(async () => { if (denied) throw new Error('Original grant denied') }) }
  const stage = vi.fn(async () => ({ payload: { staged: true } }))
  const control = createWorkerRsyncWriterControl({ ownership, accepted, binary, current: () => current, handle: stage })
  const frame = (next = binding) => ({ binding: next, signal: AbortSignal.timeout(5000) })
  const request = (method: string) => ({ kind: 'rsync-stage-v1', method, transferId: intent.transferId })
  const prepare = async () => {
    const result = RsyncControlResponseSchema.parse((await control.handle(request('writer-prepare'), frame())).payload)
    if (result.method !== 'writer-prepare') throw new Error('Unexpected prepare response')
    return { transferId: result.transferId, ownerId: result.ownerId, ownerDigest: result.ownerDigest }
  }
  const record = (ownerId: string, suffix: string) => readRecord(join(root, '.rsync-writers', intent.transferId, `${ownerId}.${suffix}`))
  return { root, binding, intent, binary, ownership, accepted, control, stage, frame, request, prepare, record,
    deny: () => { denied = true }, move: (next?: DeviceSessionBinding) => { current = next } }
}

describe.skipIf(process.platform !== 'linux')('authenticated W07 writer control', () => {
  it('reserves and reads back only the original protected server owner, with idempotent prepare', async () => {
    const f = await fixture(), reference = await f.prepare()
    expect(await f.prepare()).toEqual(reference)
    expect(f.record(reference.ownerId, 'owner')).toMatchObject({ intent: f.intent, binding: f.binding, binary: f.binary, role: 'rsync-server' })
    expect(Object.keys((await f.control.handle(f.request('writer-prepare'), f.frame())).payload as object).sort())
      .toEqual(['kind', 'method', 'ownerDigest', 'ownerId', 'transferId'])
    expect(f.stage).not.toHaveBeenCalled()
    await f.control.close()
  })

  it.each(['writer-prepare', 'writer-activate', 'writer-status', 'writer-stop'])('denies %s without original domain authority', async method => {
    const f = await fixture(); f.deny()
    await expect(f.control.handle(f.request(method), f.frame())).rejects.toThrow('Original grant denied')
    expect(f.ownership.inventory()).toEqual([])
    expect(f.stage).not.toHaveBeenCalled()
  })

  it.each(['epoch', 'generation', 'identity', 'offline'])('denies a stale %s caller before accepted readback', async change => {
    const f = await fixture()
    f.move(change === 'offline' ? undefined : { ...f.binding,
      ...(change === 'epoch' ? { connectionEpoch: randomUUID() } : change === 'generation' ? { connectionGeneration: 2 } : { keyRevision: 2 }) })
    await expect(f.control.handle(f.request('writer-prepare'), f.frame())).rejects.toThrow('Stale')
    expect(f.accepted.intent).not.toHaveBeenCalled(); expect(f.ownership.inventory()).toEqual([])
  })

  it('rejects paths, owner IDs and process flags, binary payloads and wrong original intents', async () => {
    const f = await fixture()
    for (const extra of [{ path: '/caller' }, { ownerId: randomUUID() }, { pid: process.pid }, { stopped: true }]) {
      await expect(f.control.handle({ ...f.request('writer-prepare'), ...extra }, f.frame())).rejects.toThrow()
    }
    await expect(f.control.handle(f.request('writer-prepare'), { ...f.frame(), bytes: new Uint8Array() })).rejects.toThrow('binary')
    expect(f.accepted.intent).not.toHaveBeenCalled()
    f.accepted.intent.mockResolvedValueOnce({ ...f.intent, transferId: randomUUID() })
    await expect(f.prepare()).rejects.toThrow('accepted rsync writer transfer differs')
    f.accepted.intent.mockResolvedValueOnce({ ...f.intent, deviceId: randomUUID() })
    await expect(f.prepare()).rejects.toThrow('principal differs')
    expect(f.ownership.inventory()).toEqual([])
  })

  it('revokes a prepared reservation if its post-operation authorization is denied', async () => {
    const f = await fixture()
    f.accepted.authorize.mockImplementationOnce(async () => {})
    f.accepted.authorize.mockImplementationOnce(async () => { throw new Error('Grant revoked during prepare') })
    await expect(f.prepare()).rejects.toThrow('Grant revoked')
    await f.ownership.processesQuiescent(f.intent, AbortSignal.timeout(5000), true)
    await f.control.close()
  })

  it('waits for the actual wrapper, revalidates original authority and publishes no process facts', async () => {
    const f = await fixture(), reference = await f.prepare()
    f.accepted.authorize.mockClear()
    const activated = f.control.handle(f.request('writer-activate'), f.frame())
    await vi.waitFor(() => expect(f.accepted.authorize).toHaveBeenCalledTimes(1))
    expect(f.record(reference.ownerId, 'grant')).toBeUndefined()
    const wrapper = new RsyncWriterOwnership(f.root, () => undefined)
    const waiting = wrapper.waitForServerGrant(reference, AbortSignal.timeout(5000))
    expect((await activated).payload).toEqual(f.request('writer-activate'))
    await waiting
    expect(f.accepted.authorize).toHaveBeenCalledTimes(3)
    expect(f.record(reference.ownerId, 'grant')).toMatchObject({ binding: f.binding, ownerId: reference.ownerId })
    expect(f.record(reference.ownerId, 'claim')).toBeUndefined()
    await f.control.close()
  })

  it.each(['denied', 'changed-intent', 'changed-binding'])('denies %s after WAITING and revokes the reservation', async change => {
    const f = await fixture(), reference = await f.prepare()
    f.accepted.authorize.mockClear()
    const activated = f.control.handle(f.request('writer-activate'), f.frame())
    const failure = expect(activated).rejects.toThrow()
    await vi.waitFor(() => expect(f.accepted.authorize).toHaveBeenCalledTimes(1))
    if (change === 'denied') f.deny()
    if (change === 'changed-intent') f.accepted.intent.mockResolvedValue({ ...f.intent, rootId: randomUUID() })
    if (change === 'changed-binding') f.move({ ...f.binding, connectionGeneration: 2 })
    const wrapper = new RsyncWriterOwnership(f.root, () => undefined)
    const waiting = wrapper.waitForServerGrant(reference, AbortSignal.timeout(5000)).catch(() => undefined)
    await failure; await waiting
    expect(f.record(reference.ownerId, 'grant')).toBeUndefined()
    expect(f.record(reference.ownerId, 'closed')).toMatchObject({ evidence: 'never-dispatched' })
  })

  it('requires positive original process closure for status and stop, including after reconnect', async () => {
    const f = await fixture(), reference = await f.prepare()
    await expect(f.control.handle(f.request('writer-status'), f.frame())).rejects.toThrow('pending or unconfirmed')
    const next = { ...f.binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }; f.move(next)
    expect((await f.control.handle(f.request('writer-stop'), f.frame(next))).payload).toEqual(f.request('writer-stop'))
    expect((await f.control.handle(f.request('writer-status'), f.frame(next))).payload).toEqual(f.request('writer-status'))
    expect(f.record(reference.ownerId, 'owner')).toMatchObject({ intent: f.intent, binding: f.binding })
    expect(f.record(reference.ownerId, 'closed')).toMatchObject({ evidence: 'never-dispatched' })
    await f.control.close()
  })

  it('revokes every reserved sibling on binding loss and denies activation on the lost frame', async () => {
    const f = await fixture(), reference = await f.prepare()
    f.move(undefined)
    const revoked = f.control.bindingLost(f.binding)
    expect(f.record(reference.ownerId, 'revoked')).toBeDefined()
    await revoked
    await expect(f.control.handle(f.request('writer-activate'), f.frame())).rejects.toThrow('Stale')
    expect(f.record(reference.ownerId, 'grant')).toBeUndefined()
    await f.control.close()
  })

  it('shutdown cancels an activation awaiting WAITING and retains a positive stop receipt', async () => {
    const f = await fixture(), reference = await f.prepare()
    f.accepted.authorize.mockClear()
    const activated = f.control.handle(f.request('writer-activate'), f.frame())
    const failure = expect(activated).rejects.toThrow()
    await vi.waitFor(() => expect(f.accepted.authorize).toHaveBeenCalledTimes(1))
    await f.control.close(); await failure
    expect(f.record(reference.ownerId, 'closed')).toMatchObject({ evidence: 'never-dispatched' })
    await expect(f.prepare()).rejects.toThrow('closed')
  })

  it('forwards staging methods to the existing handler under the same authenticated frame', async () => {
    const f = await fixture()
    expect(await f.control.handle(f.request('receiver-prepare'), f.frame())).toEqual({ payload: { staged: true } })
    expect(f.stage).toHaveBeenCalledWith(f.request('receiver-prepare'), expect.objectContaining({ binding: f.binding }))
    expect(f.ownership.inventory()).toEqual([])
    await f.control.close()
  })
})
