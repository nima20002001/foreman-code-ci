import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import { settleInstalledWorkflowNativeOwner } from './installedWorkflowHost.js'
import { DEVICE_APPLICATION_JSON_BYTES, negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import {
  InstalledWorkflowPhysicalReadouts,
  matchingOriginalRegistryLaunch,
  remoteWorkflowSourceDigest,
  assertOriginalPhysicalDirectories,
  pagePhysicalReadout,
  readPhysicalReadout,
} from './workflowPhysicalReadout.js'
import { RemoteWorkflowPhysicalReadoutSchema } from '@foreman-code/contracts/remote-workflow-physical'
import { repeatExecutionIdentity } from '../repeatResolution.js'
import { pageNativeHistory } from './nativeHistoryPage.js'
import {
  DeviceApplicationChannel,
  extensionDescriptors,
  type DeviceExtensionRegistration,
} from '../../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../../devices/deviceWire.js'
import { DeviceApplicationAdmissionError } from '../../devices/deviceApplicationError.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import type { NativeHistory } from '../../harnesses/port.js'
import { deferred } from '../../../../test/helpers/deferred.js'

describe('original physical source selectors and Main SQL consumer',()=>{
  it('transfers distinct large workflow and reviewer results with a bounded physical dictionary', async () => {
    const f = await physicalFixture()
    const workflowResult = { outcome: 'succeeded' as const, output: { text: 'w'.repeat(3 * 1024 * 1024) } }
    const reviewerResult = { outcome: 'succeeded' as const, output: { text: 'r'.repeat(3 * 1024 * 1024) } }
    await f.journal.retainReviewer(f.intent.operationId, { agentId: 'reviewer',
      expiresAt: '2099-01-01T00:00:00.000Z' }, { ...f.source.history,
      terminalTurn: { correlationId: f.source.history.correlationId, providerId: 'original-turn', result: workflowResult } })
    const assignment = { jobId: 'large-review', interactionId: 'interaction', reviewerAgentId: 'reviewer',
      correlationId: 'review:large-review', session: f.session }
    await f.journal.reserveReviewTurn(f.intent.operationId, assignment, 'a'.repeat(64), -1)
    await f.journal.enterReviewTurn(f.intent.operationId, assignment.correlationId)
    await f.journal.acknowledgeReviewTurn(f.intent.operationId, assignment.correlationId, 'review-turn')
    const history = { ...f.source.history, correlationId: assignment.correlationId, nativeTurnId: 'review-turn',
      terminalResult: reviewerResult, terminalTurn: { correlationId: assignment.correlationId,
        providerId: 'review-turn', result: reviewerResult } }
    await f.journal.settleReviewTurn(f.intent.operationId, history)
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('Original reviewer receipt missing')
    f.readout.receipt = status.receipt
    f.readout.history = history
    f.source.history = history
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const observation = { readout: f.readout, placement: f.placement,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
      observe: () => f.captured.launch, closure: () => null }
    try {
      readouts.remember({ ...observation, source: { type: 'boundary' } })
      readouts.remember({ ...observation, source: f.source })
      const selector = { intent: f.intent, placement: f.placement, receiptSequence: status.receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest(f.source) }
      const selected = await readouts.read(selector)
      const first = pagePhysicalReadout(selected)
      if (!('kind' in first)) throw new Error('Large physical dictionary needs bounded transfer')
      expect(first.metadata.byteSize).toBeGreaterThan(4 * 1024 * 1024)
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(DEVICE_APPLICATION_JSON_BYTES)
      const reconstructed = await readPhysicalReadout(first, async metadata =>
        pagePhysicalReadout(await readouts.read({ ...selector, metadata }), metadata))
      expect(reconstructed).toEqual(selected)
      expect(reconstructed.receipt.retainedReviewer?.result).toEqual(workflowResult)
      expect(reconstructed.history?.terminalResult).toEqual(reviewerResult)
      expect((await readouts.ack(selector)).status).toBe('retired')
      readouts.purge(f.intent.operationId)
      readouts.remember({ ...observation, source: f.source })
      expect((await readouts.read(selector)).history).toEqual(history)
    } finally {
      readouts.clear()
      await f.sqlConnection.close()
    }
  }, 30_000)

  it('retains and verifies a journal-sized terminal result across physical carrier continuations', async () => {
    const f = await physicalFixture()
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(450_000) } }
    const history = { ...f.source.history, terminalResult: result, terminalTurn: {
      correlationId: `execution:${f.intent.executionId}`, providerId: 'original-turn', result } }
    const closed = RemoteWorkflowPhysicalReadoutSchema.shape.observation.parse({ ...f.captured.launch,
      lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' })
    await f.journal.terminal(f.intent.operationId, { kind: 'completed', result,
      resultDigest: commandInputHash(result).slice('sha256:'.length),
      closureEvidenceDigest: commandInputHash({ intent: f.intent, native: f.readout.receipt.native,
        launch: f.captured.launch, physicalOwnerClosed: true }).slice('sha256:'.length) })
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('Original terminal receipt missing')
    f.source.history = history
    f.readout.receipt = status.receipt
    f.readout.history = history
    f.readout.observation = closed
    f.readout.closure = { ownerClosed: true, launch: closed }
    f.readout.output = { kind: 'text-only', result }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(3 * 1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(f.readout))).toBeGreaterThan(4 * 1024 * 1024)
    const expectedDigest = createHash('sha256')
      .update(canonicalGraphJson(f.source, REMOTE_NATIVE_SOURCE_LIMIT)).digest('hex')
    expect(remoteWorkflowSourceDigest(f.source)).toBe(expectedDigest)
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const observation = { readout: f.readout, placement: f.placement,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
      observe: () => closed, closure: () => closed }
    readouts.remember({ ...observation, source: { type: 'boundary' } })
    readouts.remember({ ...observation, source: f.source })
    class Socket extends EventEmitter {
      bufferedAmount = 0
      peer?: Socket
      closed = false
      maxFrameBytes = 0
      send(text: string) {
        this.maxFrameBytes = Math.max(this.maxFrameBytes, Buffer.byteLength(text))
        queueMicrotask(() => {
          if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
        })
      }
      close() {
        if (this.closed) return
        this.closed = true
        this.emit('close')
        this.peer?.close()
      }
    }
    const rawMain = new Socket()
    const rawWorker = new Socket()
    rawMain.peer = rawWorker
    rawWorker.peer = rawMain
    const mainSocket = adaptDeviceSocket(rawMain)
    const workerSocket = adaptDeviceSocket(rawWorker)
    const client: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1, role: 'client',
      maxJsonBytes: DEVICE_APPLICATION_JSON_BYTES, maxBinaryBytes: 0 }
    let pages = 0
    const server: DeviceExtensionRegistration = { ...client, role: 'server', handle: async raw => {
      const frame = RemoteExecutionRpcRequestSchema.parse(raw)
      if (frame.method !== 'physical-readout') throw new Error('Only original physical observation is requested')
      pages++
      const payload = pagePhysicalReadout(await readouts.read(frame), frame.metadata)
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(DEVICE_APPLICATION_JSON_BYTES)
      return { payload }
    } }
    const extensions = negotiateDeviceExtensions(extensionDescriptors([client]), extensionDescriptors([server]))
    const parent = new AbortController()
    const main = new DeviceApplicationChannel({ side: 'main', binding: f.context.binding, socket: mainSocket,
      signal: parent.signal, extensions, registrations: [client] })
    const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.context.binding, socket: workerSocket,
      signal: parent.signal, extensions, registrations: [server] })
    const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 1000),
      worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000)]
    for (const task of tasks) void task.catch(() => { /* ignore: the test awaits the operation itself; this observer only prevents an unhandled rejection. */ })
    f.request.mockImplementation(payload => main.request('execution-v1', payload))
    try {
      const original = await f.bind()
      expect(original.source).toEqual(f.source)
      await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
      const selector = { intent: f.intent, placement: f.placement, receiptSequence: status.receipt.sequence,
        sourceDigest: expectedDigest }
      const selected = await readouts.read(selector)
      const raw = pagePhysicalReadout(selected)
      const reconstructed = await readPhysicalReadout(raw, async metadata =>
        pagePhysicalReadout(await readouts.read({ ...selector, metadata }), metadata))
      expect(reconstructed).toEqual(selected)
      expect(pages).toBeGreaterThan(1)
      expect(rawWorker.maxFrameBytes).toBeLessThanOrEqual(16_384)
      expect(rawMain.closed).toBe(false)
      await expect(readouts.read({ ...selector, sourceDigest: 'f'.repeat(64) }))
        .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
      expect((await readouts.ack(selector)).status).toBe('retired')
      readouts.purge(f.intent.operationId)
      readouts.remember({ ...observation, source: f.source })
      expect((await readouts.read(selector)).history).toEqual(history)
      expect(await f.journal.status(f.intent.operationId)).toEqual(status)
    } finally {
      parent.abort()
      main.close()
      worker.close()
      await Promise.allSettled(tasks)
      readouts.clear()
      await f.sqlConnection.close()
    }
  }, 30_000)

  it.each(['closed', 'live', 'wrong owner', 'different closure'] as const)(
    'admits reboot readback only for original boot closure: %s', async state => {
      const f = await physicalFixture()
      if (state !== 'live') {
        await f.journal.revokeFence(f.intent.operationId)
        const original = await f.journal.status(f.intent.operationId)
        if (original.status !== 'known') throw new Error('Expected original native owner')
        await f.journal.terminal(f.intent.operationId, { kind: 'cancelled',
          closureEvidenceDigest: commandInputHash({ intent: f.intent, native: original.receipt.native,
            launch: f.captured.launch, physicalOwnerClosed: true }).slice('sha256:'.length) })
        const terminal = await f.journal.status(f.intent.operationId)
        if (terminal.status !== 'known') throw new Error('Expected terminal original owner')
        f.readout.receipt = terminal.receipt
        f.readout.observation = RemoteWorkflowPhysicalReadoutSchema.shape.observation.parse({ ...f.captured.launch,
          lifecycle: 'closed', closureEvidence: state === 'different closure' ? 'cgroup_v2_empty' : 'linux_boot_changed' })
        f.readout.closure = { ownerClosed: true, launch: f.readout.observation }
      }
      f.context.binding = { ...f.context.binding, bootId: randomUUID(), connectionGeneration: 10,
        connectionEpoch: randomUUID() }
      f.currentBinding.mockReturnValue(f.context.binding)
      if (state === 'wrong owner') {
        f.readout.observation = { ...f.readout.observation, owner: 'execution:foreign' }
        f.readout.closure = { ownerClosed: true, launch: f.readout.observation }
      }
      try {
        if (state === 'closed') {
          const original = await f.bind()
          await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
          expect(f.producer.passiveNativeOwner(original)).toBeUndefined()
          expect(f.readout.receipt.connection.bootId).not.toBe(f.context.binding.bootId)
          expect(f.readout.receipt.native).toMatchObject({ sessionId: f.session.nativeSessionId })
        } else {
          await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source))
            .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
        }
        expect(f.request).toHaveBeenCalledOnce()
      } finally {
        await f.sqlConnection.close()
      }
    })
  it('verifies the complete original terminal metadata after bounded physical readout continuation', async () => {
    const f = await physicalFixture()
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(65_536) } }
    Object.assign(f.source.history, { terminalResult: result, terminalTurn: {
      correlationId: `execution:${f.intent.executionId}`, providerId: 'original-turn', result } })
    f.readout.history = f.source.history
    const offsets: number[] = []
    f.request.mockImplementation(async payload => {
      const frame = payload as { metadata?: { digest: string; offset: number } }
      offsets.push(frame.metadata?.offset ?? 0)
      const value = pagePhysicalReadout(f.readout, frame.metadata)
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(DEVICE_APPLICATION_JSON_BYTES)
      return { payload: value }
    })
    const original = await f.bind()
    expect(original.source).toEqual(f.source)
    expect(offsets[0]).toBe(0)
    expect(offsets.length).toBeGreaterThan(1)
    expect(offsets.slice(1).every((offset, index) => offset > offsets[index]!)).toBe(true)
    await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
    await f.sqlConnection.close()
  })
  it('retains byte-bounded page and event selectors without copying the entire native history', async () => {
    const f = await physicalFixture()
    const events = Array.from({ length: 80 }, (_, sequence) => ({ sequence, type: 'native.notification',
      occurredAt: '2026-10-01T00:00:00.000Z', payload: { text: '漢'.repeat(6000) } }))
    const full = { ...f.source.history, events, firstRetainedSequence: 0, nextSequence: events.length }
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(DEVICE_APPLICATION_JSON_BYTES)
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const assertCurrent = vi.fn(async () => {})
    const observed: number[] = []
    let cursor = -1
    try {
      for (let count = 0; count < events.length; count++) {
        const page = pageNativeHistory(full, cursor)
        const source = { type: 'history' as const, history: page.history }
        readouts.remember({ readout: RemoteWorkflowPhysicalReadoutSchema.parse({ ...f.readout, history: page.history }), placement: f.placement, source,
          leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: assertCurrent, assertCurrent,
          observe: () => f.captured.launch, closure: () => null })
        const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
          sourceDigest: remoteWorkflowSourceDigest(source) }
        const readout = await readouts.read(selector)
        expect(Buffer.byteLength(JSON.stringify(readout))).toBeLessThanOrEqual(DEVICE_APPLICATION_JSON_BYTES)
        expect(readout.history).toEqual(page.history)
        for (const event of page.history.events) {
          const original = { type: 'event' as const, event: { ...event, executionId: f.intent.executionId } }
          expect((await readouts.read({ ...selector, sourceDigest: remoteWorkflowSourceDigest(original) }))
            .history?.events).toContainEqual(event)
          observed.push(event.sequence)
        }
        await expect(readouts.read({ ...selector, intent: { ...f.intent, executionId: 'foreign-execution' } }))
          .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
        await readouts.ack(selector)
        cursor = page.page.nextAfterSequence
        if (!page.page.hasMore) break
      }
      expect(observed).toEqual(events.map(event => event.sequence))
      expect(assertCurrent).toHaveBeenCalled()
    } finally { await f.sqlConnection.close() }
  })
  it('retains the exact earlier source, never reconstructs latest history, and expires/purges selectors',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),assertCurrent=vi.fn(async()=>{})
    const input={readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertOwnerCurrent:assertCurrent,assertCurrent,
      observe:()=>matchingOriginalRegistryLaunch(f.registry,f.captured.launch),closure:()=>null}
    readouts.remember(input)
    const selector={intent:f.intent,placement:f.placement,receiptSequence:f.readout.receipt.sequence,sourceDigest:remoteWorkflowSourceDigest(f.source)}
    expect(await readouts.read(selector)).toEqual(f.readout)
    f.source.history.nativeTurnId='later-provider-turn'
    expect((await readouts.read(selector)).history?.nativeTurnId).toBe('original-turn')
    await expect(readouts.read({...selector,sourceDigest:remoteWorkflowSourceDigest(f.source)})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    assertCurrent.mockRejectedValueOnce(new Error('Original authority revoked'))
    await expect(readouts.read(selector)).rejects.toThrow('Original authority revoked')
    await expect(readouts.read(selector)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
  it('requires private prepared/original capabilities and performs no network IO inside the owning SQL transaction',async()=>{
    const f=await physicalFixture(),original=await f.bind()
    expect(f.request).toHaveBeenCalledOnce()
    await f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))
    expect(f.request).toHaveBeenCalledOnce()
    expect(() => f.producer.bind(original, { kind: 'original-remote-physical' }, f.owner, f.lifetime))
      .toThrowError(expect.objectContaining({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'main_lifetime' },
      }))
    await f.sqlConnection.transaction(async sql=>{
      await expect(f.producer.assertOriginal(sql,f.owner,JSON.parse(JSON.stringify(original)))).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    })
    await f.sqlConnection.close()
  })
  it.each(['provider-generation','source-receipt','runtime-leaf','unconfirmed-closure','output-artifact','signed-binding'] as const)('rejects %s before issuing Main physical proof',async defect=>{
    const f=await physicalFixture()
    if(defect==='provider-generation')f.readout.observation.provider.startTicks='different-native-generation'
    if(defect==='source-receipt')f.readout.source.record.receipt.executionId='foreign-execution'
    if(defect==='runtime-leaf')f.readout.runtimeLeaf.operationId='foreign-operation'
    if(defect==='unconfirmed-closure')f.readout.observation.lifecycle='closure-unconfirmed'
    if(defect==='output-artifact')f.readout.output={kind:'text-only',result:{outcome:'succeeded',output:{fileId:'invented-result-file'}}}
    if(defect==='signed-binding')f.currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
    if(defect==='source-receipt'||defect==='runtime-leaf') {
      const original=await f.bind()
      await expect(f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    } else await expect(f.producer.prefetch(f.readout.receipt,f.placement,f.source)).rejects.toThrow()
    await f.sqlConnection.close()
  })
  it.each(['entry-reservation','main-lane-token','main-lane-turn','main-lane-expiry','current-binding','coordinator-owner'] as const)('rejects changed %s through SQL-only final verification',async defect=>{
    const f=await physicalFixture(),original=await f.bind()
    if(defect==='entry-reservation')f.entry.reservation.execution.attempt++
    if(defect==='main-lane-token')f.lane.token='replacement-native-lane-token'
    if(defect==='main-lane-turn')f.lane.provider_id='other-native-turn'
    if(defect==='main-lane-expiry')f.lane.held=false
    if(defect==='current-binding')f.currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
    if(defect==='coordinator-owner')vi.mocked(f.lifetime.assertCurrent).mockImplementation(()=>{throw new Error('Actual coordinator lifetime ended')})
    await expect(f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))).rejects.toThrow()
    expect(f.request).toHaveBeenCalledOnce()
    await f.sqlConnection.close()
  })
})

describe('bounded physical readout retention and actual terminal correlation',()=>{
  it('retains originals and event selectors until Main acknowledges after a delayed read', async () => {
    const f = await physicalFixture()
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const now = Date.now()
    const assertCurrent = vi.fn(async () => {})
    const event = { sequence: 1, type: 'native.notification', occurredAt: new Date(now).toISOString(),
      payload: { text: 'original reply' } }
    const history = { ...f.source.history, events: [event] }
    const source = { type: 'history' as const, history }
    readouts.remember({ readout: { ...f.readout, history }, placement: f.placement, source,
      leaseExpiresAt: new Date(now + 30_000).toISOString(), assertOwnerCurrent: async () => {}, assertCurrent,
      observe: () => f.captured.launch, closure: () => null })
    const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest(source) }
    const eventSelector = { ...selector, sourceDigest: remoteWorkflowSourceDigest({ type: 'event',
      event: { ...event, executionId: f.intent.executionId } }) }
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000)
    try {
      const result = await readouts.read(selector)
      expect(result.history).toEqual(history)
      expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now())
      expect(await readouts.read(eventSelector)).toEqual(result)
      expect(assertCurrent).toHaveBeenCalledTimes(2)
      expect(await readouts.ack(selector)).toMatchObject({ status: 'retired' })
      await expect(readouts.read(selector)).rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
      await expect(readouts.read(eventSelector)).rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    } finally { await f.sqlConnection.close() }
  })
  it('refuses a 129th original while Main is still using every retained reply, and frees a slot on acknowledgment',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
    const history=(index:number)=>({...f.source.history,nextSequence:index})
    const selector=(index:number)=>({intent:f.intent,placement:f.placement,receiptSequence:f.readout.receipt.sequence,
      sourceDigest:remoteWorkflowSourceDigest({type:'history',history:history(index)})})
    const observation=(index:number)=>({readout:{...f.readout,history:history(index)},placement:f.placement,
      source:{type:'history' as const,history:history(index)},leaseExpiresAt:'2099-01-01T00:00:00.000Z',
      assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})
    for(let index=0;index<128;index++) {
      readouts.remember(observation(index))
      await readouts.read(selector(index))
    }
    expect(()=>readouts.remember(observation(128))).toThrow(expect.objectContaining({code:'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE'}))
    expect((await readouts.read(selector(0))).history).toEqual(history(0))
    expect(await readouts.ack(selector(0))).toMatchObject({status:'retired'})
    expect(()=>readouts.remember(observation(128))).not.toThrow()
    await f.sqlConnection.close()
  })
  it.each(['matching','closure-digest','result-digest','foreign-result','missing-positive-closure','foreign-closure-launch'] as const)('requires original provider + positive closure + exact text output for %s terminal proof',async defect=>{
    const f=await physicalFixture(),result={outcome:'succeeded' as const,output:{text:'Actual provider text in the unit terminal snapshot.'}}
    const history={...f.source.history,terminalTurn:{correlationId:`execution:${f.intent.executionId}`,providerId:'original-turn',result}}
    const manager=new CodexAppServerSessionManager('/never-executed/unit/codex')
    vi.spyOn(manager,'close').mockResolvedValue(undefined);vi.spyOn(f.registry,'closeRegistration').mockResolvedValue(undefined);vi.spyOn(f.registry,'closeOwner').mockResolvedValue(true)
    const terminal=await settleInstalledWorkflowNativeOwner({journal:f.journal,registry:f.registry,intent:f.intent,history,captured:f.captured,manager,session:f.session})
    if(!terminal)throw new Error('Expected exact unit consumer closure receipt')
    await f.journal.terminal(f.intent.operationId,terminal)
    const status=await f.journal.status(f.intent.operationId)
    if(status.status!=='known')throw new Error('Expected retained unit terminal')
    const closed={...f.captured.launch,lifecycle:'closed' as const,closureEvidence:'cgroup_v2_empty' as const}
    f.readout.receipt=status.receipt;f.readout.history=history;f.source.history=history
    f.readout.observation=RemoteWorkflowPhysicalReadoutSchema.shape.observation.parse(closed)
    f.readout.closure={ownerClosed:true,launch:f.readout.observation};f.readout.output={kind:'text-only',result}
    if(defect==='closure-digest')f.readout.receipt.terminal!.closureEvidenceDigest='d'.repeat(64)
    if(defect==='result-digest')f.readout.receipt.terminal!.resultDigest='d'.repeat(64)
    if(defect==='foreign-result')f.readout.output.result={outcome:'succeeded',output:{text:'Other provider result'}}
    if(defect==='missing-positive-closure')delete f.readout.closure
    if(defect==='foreign-closure-launch')f.readout.closure!.launch={...f.readout.observation,launchId:randomUUID()}
    if(defect==='matching') {
      const original=await f.bind()
      await f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))
      expect(f.request).toHaveBeenCalledOnce()
    } else await expect(f.producer.prefetch(f.readout.receipt,f.placement,f.source)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
})

it('bounds the global original-source byte window and frees it only through explicit purge',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  let accepted=0
  for(let index=0;index<128;index++) {
    const history={...f.source.history,nextSequence:index,terminalResult:{outcome:'succeeded' as const,
      output:{text:`${index}:${'x'.repeat(800_000)}`}}}
    try {
      readouts.remember({readout:{...f.readout,history},placement:f.placement,source:{type:'history',history},leaseExpiresAt:'2099-01-01T00:00:00.000Z',
        assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})
      await readouts.read({intent:f.intent,placement:f.placement,receiptSequence:f.readout.receipt.sequence,
        sourceDigest:remoteWorkflowSourceDigest({type:'history',history})})
      accepted++
    } catch(error) {
      expect(error).toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE'})
      break
    }
  }
  expect(accepted).toBeGreaterThan(0);expect(accepted).toBeLessThan(128)
  readouts.purge(f.intent.operationId)
  expect(()=>readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',
    assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).not.toThrow()
  await f.sqlConnection.close()
})

describe('physical readout retention never wedges an operation',()=>{
  const observation=<History extends object>(f:Awaited<ReturnType<typeof physicalFixture>>,history:History,
    overrides:{sequence?:number;assertOwnerCurrent?:()=>Promise<void>}={})=>({
    readout:{...f.readout,history,receipt:{...f.readout.receipt,sequence:overrides.sequence??f.readout.receipt.sequence}},
    placement:f.placement,source:{type:'history' as const,history},leaseExpiresAt:'2099-01-01T00:00:00.000Z',
    assertOwnerCurrent:overrides.assertOwnerCurrent??(async()=>{}),assertCurrent:async()=>{},
    observe:()=>f.captured.launch,closure:()=>null})
  const selector=(f:Awaited<ReturnType<typeof physicalFixture>>,history:NativeHistory,
    sequence=f.readout.receipt.sequence)=>({intent:f.intent,placement:f.placement,receiptSequence:sequence,
    sourceDigest:remoteWorkflowSourceDigest({type:'history',history})})

  it('keeps accepting replies after Main read earlier replies but can no longer acknowledge them',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),now=Date.now()
    try {
      for(let index=0;index<128;index++) {
        const history={...f.source.history,nextSequence:index}
        readouts.remember(observation(f,history))
        await readouts.read(selector(f,history))
      }
      vi.spyOn(Date,'now').mockReturnValue(now+10*60_000)
      const next={...f.source.history,nextSequence:128}
      const late={...observation(f,next),readout:{...observation(f,next).readout,expiresAt:new Date(now+11*60_000).toISOString()}}
      expect(()=>readouts.remember(late)).not.toThrow()
      expect((await readouts.read(selector(f,next))).history).toEqual(next)
    } finally { vi.restoreAllMocks();await f.sqlConnection.close() }
  })
  it('does not let empty streaming polls that Main never requests block the reply it reads next',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
    try {
      for(let index=0;index<500;index++) readouts.remember(observation(f,{...f.source.history,nextSequence:index}))
      const event={sequence:500,type:'native.notification',occurredAt:new Date().toISOString(),payload:{text:'streamed'}}
      const history={...f.source.history,events:[event],nextSequence:501}
      expect(()=>readouts.remember(observation(f,history))).not.toThrow()
      const eventSelector={...selector(f,history),sourceDigest:remoteWorkflowSourceDigest({type:'event',
        event:{...event,executionId:f.intent.executionId}})}
      expect((await readouts.read(eventSelector)).history).toEqual(history)
      expect((await readouts.read(selector(f,{...f.source.history,nextSequence:499}))).history?.nextSequence).toBe(499)
      expect(await readouts.ack(eventSelector)).toMatchObject({status:'retired'})
      expect(await readouts.ack(selector(f,history))).toMatchObject({status:'retired'})
    } finally { await f.sqlConnection.close() }
  })
  it('retires a reply exactly once when its acknowledgment races a purge',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),authorized=deferred()
    try {
      const history={...f.source.history,terminalResult:{outcome:'succeeded' as const,output:{text:'shared result copy'}}}
      readouts.remember(observation(f,history,{assertOwnerCurrent:()=>authorized.promise}))
      const ack=readouts.ack(selector(f,history))
      readouts.purge(f.intent.operationId)
      authorized.resolve()
      expect(await ack).toMatchObject({status:'not_retained'})
      readouts.remember(observation(f,history))
      expect((await readouts.read(selector(f,history))).history).toEqual(history)
      expect(await readouts.ack(selector(f,history))).toMatchObject({status:'retired'})
    } finally { await f.sqlConnection.close() }
  })
  it('keeps a reply Main is still reading when a newer receipt arrives',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
    try {
      const base=f.readout.receipt.sequence,history=f.source.history
      readouts.remember(observation(f,history))
      await readouts.read(selector(f,history,base))
      readouts.remember(observation(f,history,{sequence:base+1}))
      expect((await readouts.read(selector(f,history,base))).receipt.sequence).toBe(base)
      expect(await readouts.ack(selector(f,history,base))).toMatchObject({status:'retired'})
      expect((await readouts.read(selector(f,history,base+1))).receipt.sequence).toBe(base+1)
    } finally { await f.sqlConnection.close() }
  })
})
it('rejects an expired application lease but keeps prefetched proof during Main processing',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  expect(()=>readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2020-01-01T00:00:00.000Z',
    assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).toThrow('unavailable')
  const original=await f.bind()
  vi.spyOn(Date,'now').mockReturnValue(Date.parse(f.readout.expiresAt)+1)
  await expect(f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))).resolves.toBeUndefined()
  expect(f.request).toHaveBeenCalledOnce()
  await f.sqlConnection.close()
})

describe('original physical directory revalidation after native closure',()=>{
  it.each(['', 'src'])('bounds authorization requests and their injected latency for cwd %j', async relativeCwd => {
    const f = await physicalFixture(relativeCwd)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    const requests = [deferred(), deferred()]
    let authorizationLatency = 0
    const authorize = vi.fn(async () => {
      requests[authorize.mock.calls.length - 1]!.resolve()
      authorizationLatency += 25
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    const assertCurrent = vi.fn(() => {})
    const started = performance.now()
    const inspection = assertOriginalPhysicalDirectories({ source: f.readout.source, runtimeLeaf: f.readout.runtimeLeaf,
      placement: f.placement, approvedRoots: f.approvedRoots, signal: new AbortController().signal,
      assertCurrent, authorize })
    try {
      for (const request of requests) {
        await Promise.race([request.promise, inspection])
        await vi.advanceTimersByTimeAsync(25)
      }
      await inspection
      const elapsed = performance.now() - started
      expect(authorize).toHaveBeenCalledTimes(2)
      expect(authorizationLatency).toBe(50)
      expect(elapsed).toBeGreaterThanOrEqual(45)
      expect(assertCurrent.mock.calls.length).toBeGreaterThan(20)
    } finally {
      clock.mockRestore()
      vi.useRealTimers()
      await f.sqlConnection.close()
    }
  })
  it.each(['connection', 'abort'] as const)('stops a physical inspection when its local %s fence changes', async defect => {
    const f = await physicalFixture('src')
    const controller = new AbortController()
    const authorize = vi.fn(async () => {})
    let checks = 0
    const assertCurrent = () => {
      if (++checks === 4) {
        if (defect === 'abort') controller.abort(new Error('Original readout aborted'))
        else throw new Error('Original connection changed during filesystem inspection')
      }
    }
    await expect(assertOriginalPhysicalDirectories({ source: f.readout.source, runtimeLeaf: f.readout.runtimeLeaf,
      placement: f.placement, approvedRoots: f.approvedRoots, signal: controller.signal,
      assertCurrent, authorize })).rejects.toThrow()
    expect(authorize).toHaveBeenCalledOnce()
    await f.sqlConnection.close()
  })
  it('refuses the inspection when Main denies its initial authorization', async () => {
    const f = await physicalFixture()
    const denial = new Error('Original Main read authority revoked')
    const authorize = vi.fn(async () => { throw denial })
    await expect(assertOriginalPhysicalDirectories({ source: f.readout.source, runtimeLeaf: f.readout.runtimeLeaf,
      placement: f.placement, approvedRoots: f.approvedRoots, signal: new AbortController().signal,
      assertCurrent: () => {}, authorize })).rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', cause: denial })
    expect(authorize).toHaveBeenCalledOnce()
    await f.sqlConnection.close()
  })
  it('keeps original W09 identities while observing edited bytes without granting mutable continuation',async()=>{
    const f=await physicalFixture('src'),authorize=vi.fn(async()=>{})
    await writeFile(join(f.readout.source.workingTree.canonicalCwd,'source.ts'),'Actual allowed native-edited output bytes\n')
    await assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,assertCurrent:()=>{},authorize})
    expect(authorize).toHaveBeenCalledTimes(2)
    // The original strict-byte W09 mode remains fenced; physical directory readback never changes its ownership or byte policy.
    await expect(f.sources.handle({version:1,operation:'sources.verify',record:f.nativePlacement.materialization,relativeCwd:'src'},f.context)).rejects.toThrow()
    await f.sqlConnection.close()
  })
  it.each(['source-root','source-tree','source-child-cwd','runtime-root','runtime-leaf','runtime-marker','missing-cwd'] as const)('fails unavailable for replaced or absent %s',async defect=>{
    const f=await physicalFixture('src')
    if(defect==='runtime-marker')await writeFile(join(f.readout.runtimeLeaf.canonicalRuntimeDirectory,'.graphql-workflow-runtime.json'),JSON.stringify({...f.readout.runtimeLeaf,operationId:'different-operation'}))
    else if(defect==='missing-cwd')await rm(f.readout.source.workingTree.canonicalCwd,{recursive:true})
    else {
      const path=defect==='source-root'?f.readout.source.record.receipt.binding.canonicalPath
        :defect==='source-tree'?f.readout.source.workingTree.canonicalProjectRoot
          :defect==='source-child-cwd'?f.readout.source.workingTree.canonicalCwd
            :defect==='runtime-root'?f.approvedRoots.managedRuntimeRoot:f.readout.runtimeLeaf.canonicalRuntimeDirectory
      await rename(path,`${path}-original`);await mkdir(path,{mode:0o700})
    }
    await expect(assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,assertCurrent:()=>{},authorize:async()=>{}})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
  it('rechecks authority before releasing a physical readout',async()=>{
    const f=await physicalFixture('src'),authorize=vi.fn(async()=>{})
    authorize.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{throw new Error('Original Main read authority revoked after FD open')})
    await expect(assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,assertCurrent:()=>{},authorize})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    expect(authorize).toHaveBeenCalledTimes(2)
    await f.sqlConnection.close()
  })
})

it('resolves actual original per-event selectors from the frozen reply instead of a later history snapshot',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  const event={sequence:1,connectionId:'unit-original-native-connection',type:'native.notification',occurredAt:new Date().toISOString(),payload:{value:'original-provider-event'}}
  const source={type:'history' as const,history:{...f.source.history,events:[event]}}
  const readout={...f.readout,history:source.history}
  readouts.remember({readout,placement:f.placement,source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},
    observe:()=>f.captured.launch,closure:()=>null})
  const selected={type:'event' as const,event:{...event,executionId:f.intent.executionId}}
  const selector={intent:f.intent,placement:f.placement,receiptSequence:readout.receipt.sequence,sourceDigest:remoteWorkflowSourceDigest(selected)}
  event.payload.value='later-mutated-value'
  expect((await readouts.read(selector)).history?.events[0]?.payload.value).toBe('original-provider-event')
  await expect(readouts.read({...selector,sourceDigest:remoteWorkflowSourceDigest({type:'event',event:{...selected.event,executionId:'foreign-execution'}})})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  await f.sqlConnection.close()
})

it('retires only an authenticated exact original reply and leaves journal/native outcomes unchanged',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),assertCurrent=vi.fn(async()=>{})
  readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertOwnerCurrent:assertCurrent,assertCurrent,
    observe:()=>f.captured.launch,closure:()=>null})
  const selector={intent:f.intent,placement:f.placement,receiptSequence:f.readout.receipt.sequence,sourceDigest:remoteWorkflowSourceDigest(f.source)}
  await expect(readouts.ack({...selector,intent:{...f.intent,attemptId:'different-attempt'}})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(await readouts.read(selector)).toEqual(f.readout)
  expect(await readouts.ack(selector)).toMatchObject({status:'retired',sourceDigest:selector.sourceDigest,receiptSequence:selector.receiptSequence})
  expect(await readouts.ack(selector)).toMatchObject({status:'not_retained'})
  await expect(readouts.read(selector)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(await f.journal.status(f.intent.operationId)).toEqual({status:'known',receipt:f.readout.receipt})
  expect(f.registry.snapshot().launches[0]!.lifecycle).toBe('active')
  await f.sqlConnection.close()
})

it.each(['same', 'overlapping'] as const)('refreshes event observations from a fresh %s authenticated history', async kind => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const event = { sequence: 1, type: 'native.notification', occurredAt: new Date(now).toISOString(),
    payload: { value: 'original event' } }
  const history = { ...f.source.history, events: [event] }
  const source = { type: 'history' as const, history }
  const observation = {
    readout: { ...f.readout, history, expiresAt: new Date(now + 60_000).toISOString() },
    placement: f.placement, source, leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
    observe: () => f.captured.launch, closure: () => null,
  }
  readouts.remember(observation)
  clock.mockReturnValue(now + 50_000)
  const refreshed = kind === 'same' ? history : { ...history, nextSequence: 2 }
  readouts.remember({ ...observation,
    source: { type: 'history', history: refreshed },
    readout: { ...observation.readout, history: refreshed, expiresAt: new Date(now + 110_000).toISOString() },
  })
  clock.mockReturnValue(now + 65_000)
  const selected = { type: 'event' as const, event: { ...event, executionId: f.intent.executionId } }
  const result = await readouts.read({ intent: f.intent, placement: f.placement,
    receiptSequence: f.readout.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(selected) })
  expect(result.history?.events[0]?.payload.value).toBe('original event')
  expect(result.expiresAt).toBe(new Date(now + 110_000).toISOString())
  await f.sqlConnection.close()
})

it('authorizes observation retirement without reopening an already published physical source', async () => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const physical = vi.fn(async () => {})
  const owner = vi.fn(async () => {})
  const observation = { readout: f.readout, placement: f.placement, source: f.source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: owner, assertCurrent: physical,
    observe: () => f.captured.launch, closure: () => null }
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
    sourceDigest: remoteWorkflowSourceDigest(f.source) }
  readouts.remember(observation)
  expect(await readouts.read(selector)).toEqual(f.readout)
  physical.mockRejectedValue(new Error('Physical source is no longer readable'))
  expect(await readouts.ack(selector)).toMatchObject({ status: 'retired' })
  readouts.remember(observation)
  await expect(readouts.read(selector)).rejects.toThrow('Physical source is no longer readable')
  readouts.remember(observation)
  owner.mockRejectedValue(new Error('Original owner revoked'))
  await expect(readouts.ack(selector)).rejects.toThrow('Original owner revoked')
  expect(await f.journal.status(f.intent.operationId)).toEqual({ status: 'known', receipt: f.readout.receipt })
  await f.sqlConnection.close()
})

it('cannot ACK physical packet delivery or precommit verification; only the exact durable canonical source permits ACK',async()=>{
  const f=await physicalFixture(),original=await f.bind()
  await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  await f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))
  await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  f.canonicalProofs.push({record:{execution:repeatExecutionIdentity(f.execution),session:f.session,original:f.source}})
  await f.sqlConnection.transaction(async sql=>{
    await f.producer.assertOriginal(sql,f.owner,original)
    await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  })
  f.request.mockImplementation(async payload=>{
    const input=payload as {method:string;receiptSequence:number;sourceDigest:string}
    expect(input.method).toBe('physical-ack')
    return {payload:{version:1,operationId:f.intent.operationId,receiptSequence:input.receiptSequence,sourceDigest:input.sourceDigest,status:'retired'}}
  })
  expect(await f.producer.acknowledge(original)).toMatchObject({status:'retired',sourceDigest:original.sourceDigest})
  expect(await f.producer.acknowledgeReply(original)).toMatchObject({status:'retired'})
  await f.sqlConnection.close()
})

it('retains proof when the owning canonical transaction rolls back instead of sending a false durable ACK',async()=>{
  const f=await physicalFixture(),original=await f.bind()
  f.canonicalProofs.push({record:{execution:repeatExecutionIdentity(f.execution),session:f.session,original:f.source}})
  await expect(f.sqlConnection.transaction(async sql=>{await f.producer.assertOriginal(sql,f.owner,original);throw new Error('Canonical publication rolled back')})).rejects.toThrow('rolled back')
  await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(f.request).toHaveBeenCalledOnce()
  await f.sqlConnection.close()
})

describe('passive original remote telemetry precision, no native or database IO', () => {
  it('returns only the privately bound original owner and authenticated binding without IO', async () => {
    const f = await physicalFixture(), original = await f.bind()
    const passive = f.producer.passiveNativeOwner(original)!
    expect(passive.nativeOwner).toBe(f.readout.launch.owner)
    expect(passive.native).toEqual(f.readout.receipt.native)
    expect(passive.binding).toEqual(f.context.binding)
    passive.native.sessionId = 'mutated-readback'
    expect(f.producer.passiveNativeOwner(original)!.native.sessionId).toBe(f.session.nativeSessionId)
    passive.assertCurrent()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.query).not.toHaveBeenCalled()
    expect(f.producer.passiveNativeOwner({ ...original })).toBeUndefined()
    await f.sqlConnection.close()
  })
  it.each(['expired', 'revoked', 'original-binding'] as const)('withdraws %s precision and invalidates captured fences', async defect => {
    const f = await physicalFixture(), original = await f.bind(), passive = f.producer.passiveNativeOwner(original)!
    if (defect === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.readout.expiresAt) + 1)
    if (defect === 'revoked') vi.mocked(f.lifetime.assertCurrent).mockImplementation(() => { throw new Error('Original writer revoked') })
    if (defect === 'original-binding') f.currentBinding.mockReturnValue({ ...f.context.binding, connectionEpoch: randomUUID() })
    expect(f.producer.passiveNativeOwner(original)).toBeUndefined()
    expect(() => passive.assertCurrent()).toThrow()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.query).not.toHaveBeenCalled()
    await f.sqlConnection.close()
  })
  it('keeps a retained original reply through a transient authorization failure so the retry reads it', async () => {
    const f = await physicalFixture(), readouts = new InstalledWorkflowPhysicalReadouts(), assertCurrent = vi.fn(async () => {})
    readouts.remember({ readout: f.readout, placement: f.placement, source: f.source, leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      assertOwnerCurrent: assertCurrent, assertCurrent, observe: () => matchingOriginalRegistryLaunch(f.registry, f.captured.launch), closure: () => null })
    const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(f.source) }
    assertCurrent.mockRejectedValueOnce(new DeviceApplicationAdmissionError('backpressure'))
    await expect(readouts.read(selector)).rejects.toMatchObject({ code: 'backpressure' })
    expect(await readouts.read(selector)).toEqual(f.readout)
    await f.sqlConnection.close()
  })
})
