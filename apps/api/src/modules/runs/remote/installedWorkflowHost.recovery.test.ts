import { InstalledWorkflowRecovery } from './installedWorkflowRecovery.js'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import * as workerMcpEndpoint from './workerMcpEndpoint.js'
import {
  ExecutionFactsRequestSchema,
  ExecutionAuthorityRequestSchema,
} from '@foreman-code/contracts/execution-authority'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import * as installedInspection from '../../harnesses/installedCodexInspection.js'
import { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import {
  hasPositiveRemoteEntryClosure,
  hasPositiveRemoteNonEntryClosure,
} from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { RemoteOperationJournal } from './operationJournal.js'
import { createInstalledWorkflowHost, type InstalledWorkflowHostOptions } from './installedWorkflowHost.js'
import { DEVICE_APPLICATION_JSON_BYTES, negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import {
  DeviceApplicationChannel,
  extensionDescriptors,
  type DeviceExtensionRegistration,
} from '../../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../../devices/deviceWire.js'
import { journals, sourceFixture, restartedInstalledFixture, constructionFixture, delayedFacts } from './__tests__/installedWorkflowHost.js'
import { deferred } from '../../../../test/helpers/deferred.js'

describe('installed worker cold recovery', () => {
  it('settles an interrupted write-ahead registration before journal acceptance without a replacement launch', async () => {
    const f = await restartedInstalledFixture({ accepted: false, acknowledged: false, sessionCaptured: false })
    await f.journal.close()
    const host = await f.startHost()
    const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession')
    try {
      const reply = await host.extensions[0]!.handle!({ method: 'status', intent: f.intent, placement: f.placement }, f.context)
      const receipt = RemoteOperationReceiptSchema.parse((reply.payload as { receipt: unknown }).receipt)
      expect(hasPositiveRemoteNonEntryClosure(receipt)).toBe(true)
      expect(f.registry.snapshot().launches[0]?.lifecycle).toBe('closed')
      expect(create).not.toHaveBeenCalled()
    } finally { await host.close() }
  })
  it('stops an unentered retained operation without qualification or a native launch', async () => {
    const f = await restartedInstalledFixture()
    const intent = { ...f.intent, executionId: 'unentered-execution', operationId: 'unentered-operation', attemptId: 'unentered-attempt' }
    await f.journal.accept(intent, DeviceConnectionIdentitySchema.strip().parse(f.context.binding), randomUUID())
    await f.journal.close()
    const host = await f.startHost()
    const reserve = vi.spyOn(NativeProcessRegistry.prototype, 'reserveLaunch')
    const inspect = vi.spyOn(installedInspection, 'inspectInstalledCodex')
    try {
      const reply = await host.extensions[0]!.handle!({ method: 'control', intent, placement: f.placement,
        command: { schemaVersion: 1, protocolVersion: 1, commandId: 'stop-unentered', operationId: intent.operationId,
          attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash,
          owner: intent.owner, action: { kind: 'stop' } } }, f.context)
      const receipt = RemoteOperationReceiptSchema.parse((reply.payload as { receipt: unknown }).receipt)
      expect(hasPositiveRemoteNonEntryClosure(receipt)).toBe(true)
      expect(reserve).not.toHaveBeenCalled()
      expect(inspect).not.toHaveBeenCalled()
    } finally { await host.close() }
  })
  it.each([false, true])('closes entry interrupted before ACK with session capture %s, retaining the same outcome after restart', async sessionCaptured => {
    const f = await restartedInstalledFixture({ acknowledged: false, sessionCaptured })
    await f.journal.close()
    const host = await f.startHost()
    let payload: unknown
    try {
      payload = (await host.extensions[0]!.handle!({ method: 'status', intent: f.intent, placement: f.placement }, f.context)).payload
      expect(payload).toMatchObject({ status: 'known', receipt: { phase: 'confirmed_terminal', stopFence: true,
        turnEntryAttempted: false, terminal: { kind: 'cancelled' } } })
      const receipt = RemoteOperationReceiptSchema.parse((payload as { receipt: unknown }).receipt)
      if (sessionCaptured) expect(receipt.native).toEqual(f.native)
      else {
        expect(receipt.native).toBeUndefined()
        expect(hasPositiveRemoteEntryClosure(receipt)).toBe(true)
        expect(receipt.terminal?.entryClosure?.launches).toEqual([{ ...f.launch, lifecycle: 'closed', closureEvidence: 'linux_boot_changed' }])
        const prepare = await host.extensions[0]!.handle!({ method: 'prepare', intent: f.intent,
          placement: f.placement, request: f.request, executionPlacement: f.nativePlacement }, f.context)
        expect(prepare.payload).toEqual({ status: payload })
        expect((await host.extensions[0]!.handle!({ method: 'pending', intent: f.intent,
          placement: f.placement }, f.context)).payload).toBeNull()
      }
    } finally { await host.close() }
    const restarted = await f.startHost()
    try {
      expect((await restarted.extensions[0]!.handle!({ method: 'status', intent: f.intent, placement: f.placement }, f.context)).payload)
        .toEqual(payload)
    } finally { await restarted.close() }
  })
  it('requires authenticated Main authority before closing the retained original owner', async () => {
    const f = await restartedInstalledFixture()
    await f.journal.close()
    const host = await f.startHost()
    const launch = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession')
    const inspect = vi.spyOn(installedInspection, 'inspectInstalledCodex')
    f.deny()
    try {
      await expect(host.extensions[0]!.handle!({ method: 'status', intent: f.intent, placement: f.placement }, f.context))
        .rejects.toThrow('Main denied recovery')
      expect(f.registry.snapshot().launches[0]?.lifecycle).toBe('closure-unconfirmed')
      f.allow()
      const completedRequest = new AbortController()
      const reply = await host.extensions[0]!.handle!({ method: 'status', intent: f.intent, placement: f.placement },
        { ...f.context, signal: completedRequest.signal })
      completedRequest.abort(new Error('Carrier request completed'))
      expect(reply.payload).toMatchObject({ status: 'known', receipt: { phase: 'confirmed_terminal', stopFence: true,
        native: { ...f.native, turnId: 'original-turn' }, terminal: { kind: 'cancelled' } } })
      const status = reply.payload as { receipt: { sequence: number } }
      const physical = await host.extensions[0]!.handle!({ method: 'physical-readout', intent: f.intent, placement: f.placement,
        receiptSequence: status.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest({ type: 'boundary' }) }, f.context)
      expect(physical.payload).toMatchObject({ session: f.session, launch: f.launch,
        observation: { lifecycle: 'closed', closureEvidence: 'linux_boot_changed' },
        closure: { ownerClosed: true }, launchIntent: f.intent })
      expect(launch).not.toHaveBeenCalled()
      expect(inspect).not.toHaveBeenCalled()
      const registryModule = new URL('../../harnesses/recovery/processRegistry.ts', import.meta.url).href
      const script = `
        const { NativeProcessRegistry } = await import(${JSON.stringify(registryModule)});
        process.stdout.write(JSON.stringify(new NativeProcessRegistry(process.argv[1]).snapshot()));
      `
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
        f.registry.scope(f.launch.owner).root], { stdio: ['ignore', 'pipe', 'pipe'] })
      let serialized = ''
      let errors = ''
      child.stdout.on('data', chunk => { serialized += String(chunk) })
      child.stderr.on('data', chunk => { errors += String(chunk) })
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      expect(exitCode, errors).toBe(0)
      expect(JSON.parse(serialized).launches).toContainEqual({ ...f.launch,
        lifecycle: 'closed', closureEvidence: 'linux_boot_changed' })
      await host.close()
      const restarted = await f.startHost()
      try {
        expect((await restarted.extensions[0]!.handle!({ method: 'status', intent: f.intent, placement: f.placement }, f.context)).payload)
          .toEqual(reply.payload)
      } finally { await restarted.close() }
    } finally { await host.close() }
  })
  it('preserves the original completed result while reconciling registry closure after restart', async () => {
    const f = await restartedInstalledFixture()
    const result = { outcome: 'succeeded' as const, output: { text: 'original provider answer' } }
    const terminal = { kind: 'completed' as const, result, resultDigest: commandInputHash(result).slice('sha256:'.length),
      closureEvidenceDigest: commandInputHash({ intent: f.intent, native: { ...f.native, turnId: 'original-turn' },
        launch: f.launch, physicalOwnerClosed: true }).slice('sha256:'.length) }
    await f.recovery.rememberOutput(f.intent.operationId, { kind: 'text-only', result })
    await f.journal.terminal(f.intent.operationId, terminal)
    const before = await f.journal.status(f.intent.operationId)
    await f.journal.close()
    const host = await f.startHost()
    try {
      const reply = await host.extensions[0]!.handle!({ method: 'history', intent: f.intent, placement: f.placement }, f.context)
      expect(reply.payload).toMatchObject({ status: before, history: { terminalResult: result,
        terminalTurn: { correlationId: `execution:${f.intent.executionId}`, providerId: 'original-turn', result } } })
    } finally { await host.close() }
  })

  it.each(['prepare', 'reattach'] as const)(
    'retains the returned session selector for physical readback after recovered %s', async method => {
      const f = await restartedInstalledFixture()
      await f.journal.close()
      const host = await f.startHost()
      const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession')
      const attach = vi.spyOn(CodexAppServerSessionManager.prototype, 'attachSession')
      try {
        const reply = await host.extensions[0]!.handle!({ method, intent: f.intent, placement: f.placement,
          request: f.request, ...(method === 'reattach' ? { session: f.session } : {}) }, f.context)
        const payload = reply.payload as { session: unknown; status: { receipt: unknown } }
        expect(payload.session).toEqual(f.session)
        const receipt = RemoteOperationReceiptSchema.parse(payload.status.receipt)
        const physical = await host.extensions[0]!.handle!({ method: 'physical-readout',
          intent: f.intent, placement: f.placement, receiptSequence: receipt.sequence,
          sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }),
        }, f.context)
        expect(physical.payload).toMatchObject({ receipt, session: f.session,
          closure: { ownerClosed: true, launch: { lifecycle: 'closed', closureEvidence: 'linux_boot_changed' } } })
        await expect(host.extensions[0]!.handle!({ method: 'physical-readout',
          intent: f.intent, placement: f.placement, receiptSequence: receipt.sequence,
          sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created',
            session: { ...f.session, nativeSessionId: 'another-session' } }),
        }, f.context)).rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
        await expect(host.extensions[0]!.handle!({ method, intent: f.intent, placement: f.placement,
          request: { ...f.request, input: { changed: true } },
          ...(method === 'reattach' ? { session: f.session } : {}),
        }, f.context)).rejects.toThrow('Original workflow recovery request changed')
        expect(create).not.toHaveBeenCalled()
        expect(attach).not.toHaveBeenCalled()
      } finally { await host.close() }
    },
  )
})

describe('lazy installed worker host qualification boundary',()=>{
  it('rejects unavailable Main qualification before journaling or launching an inspected installation', async () => {
    const f = await constructionFixture()
    f.readMain.mockRejectedValue(new Error('Actual Main qualification is unavailable'))
    const reserve = vi.spyOn(f.registry, 'reserveLaunch')
    const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession')
    try {
      await expect(f.handler({ method: 'prepare', intent: f.intent, placement: f.placement,
        request: f.request, executionPlacement: f.nativePlacement }, f.context))
        .rejects.toThrow('Actual Main qualification is unavailable')
      expect(f.inspect).toHaveBeenCalledOnce()
      expect(f.readMain).toHaveBeenCalledOnce()
      expect(f.openJournal).not.toHaveBeenCalled()
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'unknown' })
      expect(reserve).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    } finally { await f.host.close() }
  })
  it('closes and retires a saved OpenCode preparation without allocating another native session', async () => {
    const f = await constructionFixture()
    const savedSession = { harness: 'opencode' as const, providerVersion: '1.18.31',
      nativeSessionId: 'saved-opencode-session' }
    const originalSession = structuredClone(savedSession)
    const cleanupOwner = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const,
      preparationNativeSession: savedSession }
    const native = { sessionId: savedSession.nativeSessionId, processIdentityDigest: 'a'.repeat(64) }
    await f.journal.accept(f.intent, DeviceConnectionIdentitySchema.strip().parse(f.context.binding), randomUUID())
    await f.journal.reserveEntry(f.intent.operationId)
    await f.journal.acknowledgeStart(f.intent.operationId, native)
    const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession')
    const reserve = vi.spyOn(f.registry, 'reserveLaunch')
    const closeOwner = vi.spyOn(f.registry, 'closeOwner').mockResolvedValue(false)
    try {
      expect(await f.host.preparationClosed({ ...cleanupOwner, preparationNativeSession: {
        ...savedSession, nativeSessionId: 'foreign-session',
      } })).toBe(false)
      expect(closeOwner).not.toHaveBeenCalled()
      expect(await f.host.preparationClosed(cleanupOwner)).toBe(false)
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { native, stopFence: true },
      })
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(false)
      f.snapshot.mockReturnValue({ revision: 'closed', launches: [{ ...f.launch,
        lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }] })
      closeOwner.mockResolvedValue(true)
      expect(await f.host.preparationClosed(cleanupOwner)).toBe(true)
      expect(closeOwner).toHaveBeenLastCalledWith(`execution:${f.intent.executionId}`)
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', native, stopFence: true,
          terminal: { kind: 'cancelled' } },
      })
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
      const retired = await f.journal.status(f.intent.operationId)
      expect(await f.host.preparationClosed(cleanupOwner)).toBe(true)
      expect(await f.journal.status(f.intent.operationId)).toEqual(retired)
      expect(cleanupOwner.preparationNativeSession).toEqual(originalSession)
      expect(f.inspect).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(reserve).not.toHaveBeenCalled()
    } finally { await f.host.close() }
  })
  it('cannot turn a local version selection into Main qualification, journal entry or native launch',async()=>{
    const f=await sourceFixture(),binary=join(f.root,'codex'),file=join(f.root,'installed-workflow.json')
    await writeFile(binary,Buffer.concat([Buffer.from([0x7f,0x45,0x4c,0x46]),Buffer.from('unit bytes, never executed')]),{mode:0o700})
    await writeFile(file,JSON.stringify({schemaVersion:1,codexBinary:binary,appMcpLauncher:join(f.root,'launcher.mjs'),expectedVersion:'codex-cli 0.132.0',payloadPaths:[]}),{mode:0o600})
    const currentBinding=vi.fn(()=>f.context.binding),readMain=vi.fn().mockRejectedValue(new Error('Actual Main qualification is unavailable'))
    const reserve=vi.spyOn(NativeProcessRegistry.prototype,'reserveLaunch'),create=vi.spyOn(CodexAppServerSessionManager.prototype,'createSession').mockRejectedValue(new Error('Native entry must not occur in this source check'))
    let retainedJournal: RemoteOperationJournal | undefined
    const options:InstalledWorkflowHostOptions={stateDirectory:f.root,mainNow:()=>Date.now(),pairing:{formatVersion:1,mainId:f.context.binding.mainId,deviceId:f.context.binding.deviceId,
      workerInstallationId:f.context.binding.workerInstallationId,keyRevision:1,authorizationRevision:1,endpoint:'wss://unit.invalid/device',mainPublicKeyFingerprint:'a'.repeat(64),credential:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z'},
      bootId:f.context.binding.bootId,configuration:{path:file,ownerUid:process.getuid!()},currentBinding,captureRequest:()=>({binding:f.context.binding,request:readMain}),
      sources:f.sources,approvedRoots:async()=>f.approvedRoots,codexSuiteRevision:'codex-live-4',signal:new AbortController().signal,
      journal: async () => retainedJournal ??= await RemoteOperationJournal.open(join(f.root, 'workflow-operations.json'),
        { initializeNewInstallation: true })}
    const host=await createInstalledWorkflowHost(options)
    expect(host.kind).toBe('configured')
    if(host.kind!=='configured')throw new Error('Expected unit configured code support')
    try {
      const negotiated = negotiateDeviceExtensions([
        { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server' },
        { ...WORKER_MCP_EXTENSION, role: 'server' },
      ], host.extensions)
      expect(negotiated).toEqual([
        expect.objectContaining({ namespace: 'execution-authority-v1', workerCanRequest: true, mainCanRequest: false }),
        expect.objectContaining({ namespace: 'worker-mcp-v2', workerCanRequest: true, mainCanRequest: false }),
      ])
      const handler=host.extensions[0]!.handle!
      await expect(handler({method:'prepare',intent:f.intent,placement:f.placement,request:f.request,executionPlacement:f.nativePlacement},f.context)).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
      expect(readMain).not.toHaveBeenCalled()
      expect(reserve).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled()
      await expect(access(join(f.root,'workflow-operations.json'))).rejects.toThrow()
      expect(await host.preparationClosed({ ...f.owner, preparationKind: 'workflow' })).toBe(false)
      expect(await host.preparationClosed({ ...f.owner, preparationKind: 'workflow', preparationClosed: true })).toBe(true)
      const connection = DeviceConnectionIdentitySchema.strip().parse(f.context.binding)
      await retainedJournal!.accept(f.intent, connection, randomUUID())
      expect(await host.preparationClosed({ ...f.owner, preparationKind: 'workflow', preparationClosed: true })).toBe(true)
      expect(await retainedJournal!.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', entryAttempted: false, terminal: { kind: 'not_started' } },
      })
      expect(await retainedJournal!.isRetired(f.intent.operationId)).toBe(true)
      readMain.mockImplementation(async input => {
        const request = input as { action: string; intent: typeof f.intent }
        return { payload: { version: 1, action: request.action, operationId: request.intent.operationId,
          attemptId: request.intent.attemptId, bindingHash: request.intent.bindingHash, owner: request.intent.owner } }
      })
      const retiredStatus = await retainedJournal!.status(f.intent.operationId)
      expect(await handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context))
        .toEqual({ payload: retiredStatus })
      expect(await handler({ method: 'control', intent: f.intent, placement: f.placement,
        command: { schemaVersion: 1, protocolVersion: 1, commandId: 'retired-stop',
          operationId: f.intent.operationId, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
          bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } } }, f.context))
        .toEqual({ payload: retiredStatus })
      await expect(handler({ method: 'control', intent: f.intent, placement: f.placement,
        command: { schemaVersion: 1, protocolVersion: 1, commandId: 'foreign-stop',
          operationId: 'foreign-operation', executionId: f.intent.executionId, attemptId: f.intent.attemptId,
          bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } } }, f.context))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE',
          details: { reason: 'retired_control_ownership_changed' } })
      readMain.mockRejectedValue(new Error('Original grant revoked'))
      await expect(handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context))
        .rejects.toThrow('Original grant revoked')
      expect(await retainedJournal!.status(f.intent.operationId)).toEqual(retiredStatus)
      expect(reserve).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      const interrupted = { ...f.intent, executionId: 'interrupted-execution', attemptId: 'interrupted-attempt', operationId: 'interrupted-operation' }
      const cleanupOwner = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const,
        identity: { ...f.owner.identity, operationId: interrupted.operationId },
        attempt: { ...f.owner.attempt, executionId: interrupted.executionId, attemptId: interrupted.attemptId } }
      await retainedJournal!.accept(interrupted, connection, randomUUID())
      await retainedJournal!.reserveEntry(interrupted.operationId)
      await retainedJournal!.acknowledgeStart(interrupted.operationId, { sessionId: 'unacknowledged-on-main', processIdentityDigest: 'a'.repeat(64) })
      const closeOwner = vi.spyOn(NativeProcessRegistry.prototype, 'closeOwner').mockResolvedValue(false)
      expect(await host.preparationClosed(cleanupOwner)).toBe(false)
      closeOwner.mockResolvedValue(true)
      expect(await host.preparationClosed(cleanupOwner)).toBe(true)
      expect(closeOwner).toHaveBeenLastCalledWith('execution:interrupted-execution')
      expect(await retainedJournal!.status(interrupted.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', native: { sessionId: 'unacknowledged-on-main' },
          terminal: { kind: 'cancelled' } },
      })
      expect(await host.preparationClosed({ ...cleanupOwner, preparationNativeSession: {
        harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'another-session',
      } })).toBe(false)
      currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
      await expect(handler({method:'status',intent:f.intent,placement:f.placement},f.context)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    } finally {await host.close(); await retainedJournal?.close()}
  })
})

describe('installed workflow construction concurrency', () => {
  it.each([
    ['qualification', false], ['thread acknowledgement', false],
    ['qualification', true], ['thread acknowledgement', true],
  ] as const)(
    'closes an original pending %s on reconnect while the worker remains alive (status first: %s)',
    async (stage, statusFirst) => {
      const f = await constructionFixture()
      const entered = deferred()
      const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockImplementation(async (_input, signal) => {
        entered.resolve()
        if (!signal) throw new Error('Expected original preparation cancellation')
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        if (stage === 'qualification') signal.throwIfAborted()
        return f.session
      })
      const dispose = vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
      const closed = { ...f.launch, lifecycle: 'closed' as const, closureEvidence: 'cgroup_v2_empty' as const }
      vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => ({ ...f.registry.scope(owner), launchId: f.launch.launchId }))
      vi.spyOn(f.registry, 'abandonReservedLaunch').mockResolvedValue(false)
      const closeOwner = vi.spyOn(f.registry, 'closeOwner').mockImplementation(async () => {
        f.snapshot.mockReturnValue({ revision: 'closed', launches: [closed] })
        return true
      })
      vi.spyOn(f.registry, 'closedRegistration').mockReturnValue(closed)
      vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => ({
        endpoint: 'http://unit.invalid/mcp', close: async () => {}, bindRelay: async () => {}, refreshLease: () => relay.refresh!(),
      }))
      const access = { kind: 'scoped-worker-mcp', token: 'original-token', executionId: f.intent.executionId,
        agentId: f.request.configuration.agentId, operationId: f.intent.operationId, attemptId: f.intent.attemptId,
        bindingHash: f.intent.bindingHash }
      const pending = f.handler({ method: 'prepare', intent: f.intent, placement: f.placement,
        request: f.request, executionPlacement: f.nativePlacement, applicationAccess: access }, f.context)
      const rejected = expect(pending).rejects.toThrow()
      try {
        await entered.promise
        const before = await f.journal.status(f.intent.operationId)
        expect(before).toMatchObject({ status: 'known', receipt: { entryAttempted: true } })
        if (before.status !== 'known') throw new Error('Expected registered preparation')
        expect(before.receipt.native).toBeUndefined()
        const binding = { ...f.context.binding, connectionGeneration: f.context.binding.connectionGeneration + 1,
          connectionEpoch: randomUUID() }
        f.currentBinding.mockReturnValue(binding)
        const context = { binding, signal: new AbortController().signal }
        if (statusFirst) {
          const status = await f.handler({ method: 'status', intent: f.intent, placement: f.placement }, context)
          expect(status.payload).toMatchObject({ status: 'known', receipt: { entryAttempted: true } })
          expect((status.payload as { receipt: { native?: unknown } }).receipt.native).toBeUndefined()
          expect(closeOwner).not.toHaveBeenCalled()
        }
        const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'stop-original-preparation',
          operationId: f.intent.operationId, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
          bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } }
        f.deny()
        await expect(f.handler({ method: 'control', intent: f.intent, placement: f.placement, command }, context))
          .rejects.toThrow('Main denied')
        expect(closeOwner).not.toHaveBeenCalled()
        const authority = f.readMain.getMockImplementation()!
        f.readMain.mockImplementation(async raw => {
          const parsed = ExecutionAuthorityRequestSchema.safeParse(raw)
          if (!parsed.success) return authority(raw)
          return { payload: { version: 1, action: parsed.data.action, operationId: f.intent.operationId,
            attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, owner: f.intent.owner } }
        })
        if (statusFirst) {
          await expect(f.handler({ method: 'control', intent: f.intent, placement: f.placement,
            command: { ...command, commandId: 'stale-stop', owner: { grantId: 'stale-owner', epoch: '2' } },
          }, context)).rejects.toThrow('Stale control ownership')
          expect(closeOwner).not.toHaveBeenCalled()
        }
        const response = await f.handler({ method: 'control', intent: f.intent, placement: f.placement, command }, context)
        const receipt = RemoteOperationReceiptSchema.parse((response.payload as { receipt: unknown }).receipt)
        expect(hasPositiveRemoteEntryClosure(receipt)).toBe(true)
        expect(receipt.native).toBeUndefined()
        expect(receipt.connection).toEqual(DeviceConnectionIdentitySchema.strip().parse(f.context.binding))
        await rejected
        expect(create).toHaveBeenCalledOnce()
        expect(dispose).toHaveBeenCalled()
        expect(closeOwner).toHaveBeenCalledWith(`execution:${f.intent.executionId}`, expect.any(AbortSignal))
        const owner = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const }
        expect(await f.host.preparationClosed(owner)).toBe(true)
        expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
        expect((await f.handler({ method: 'status', intent: f.intent, placement: f.placement }, context)).payload)
          .toMatchObject({ status: 'known', receipt: { terminal: { kind: 'cancelled' } } })
        await f.host.close()
        await f.journal.close()
        const restored = await RemoteOperationJournal.open(join(f.root, 'construction-journal'))
        journals.push(restored)
        const persisted = await restored.status(f.intent.operationId)
        expect(persisted.status === 'known' && hasPositiveRemoteEntryClosure(persisted.receipt)).toBe(true)
        expect(await restored.isRetired(f.intent.operationId)).toBe(true)
      } finally {
        await f.host.close()
        await rejected
      }
    })

  it('authorizes and delivers Stop through the installed handler while all worker-to-Main ordinary slots are occupied', async () => {
    const f = await constructionFixture()
    class Socket extends EventEmitter {
      bufferedAmount = 0
      peer?: Socket
      closed = false
      send(text: string) {
        queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false) })
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
    const occupied = deferred()
    const release = deferred()
    let entered = 0
    const authority = vi.fn(async (payload: unknown) => {
      if (payload === 'occupied') {
        if (++entered === 8) occupied.resolve()
        await release.promise
        return { payload: null }
      }
      if (payload === 'ordinary') return { payload: { admitted: true } }
      return f.readMain(payload)
    })
    const mainRegistrations: DeviceExtensionRegistration[] = [
      { namespace: 'execution-v1', version: 1, role: 'client', maxJsonBytes: DEVICE_APPLICATION_JSON_BYTES, maxBinaryBytes: 0 },
      { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server', handle: authority },
      { ...WORKER_MCP_EXTENSION, role: 'server', handle: payload => f.readMain(payload) },
    ]
    const extensions = negotiateDeviceExtensions(extensionDescriptors(mainRegistrations), extensionDescriptors(f.host.extensions))
    const parent = new AbortController()
    const main = new DeviceApplicationChannel({ side: 'main', binding: f.context.binding, socket: mainSocket,
      signal: parent.signal, extensions, registrations: mainRegistrations })
    const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.context.binding, socket: workerSocket,
      signal: parent.signal, extensions, registrations: f.host.extensions })
    f.setApplicationChannel(worker)
    const readers = [main.run(mainSocket.messages[Symbol.asyncIterator](), 2000),
      worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000)]
    for (const reader of readers) void reader.catch(() => {
      // ignore: channel shutdown is asserted by awaiting all readers below.
    })
    const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockResolvedValue(f.session)
    vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => f.registry.scope(owner))
    vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
      residency: { session: f.session, connectionId: 'unit-native-connection', runtimeGeneration: 1, nativeTurnId: undefined },
      assertCurrent: () => {},
    })
    vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => ({
      endpoint: 'http://unit.invalid/mcp', close: async () => {}, bindRelay: async () => {}, refreshLease: () => relay.refresh!(),
    }))
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockResolvedValue({ events: [], pendingInteractions: [],
      correlationId: `execution:${f.intent.executionId}` })
    const cancel = vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockResolvedValue(true)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockResolvedValue(undefined)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
    vi.spyOn(f.registry, 'closeRegistration').mockResolvedValue(undefined)
    vi.spyOn(f.registry, 'closeOwner').mockImplementation(async () => {
      f.snapshot.mockReturnValue({ revision: 'snapshot:closed', launches: [{ ...f.launch,
        lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }] })
      return true
    })
    const pending: Promise<unknown>[] = []
    try {
      await main.request('execution-v1', { method: 'prepare', intent: f.intent, placement: f.placement,
        request: f.request, executionPlacement: f.nativePlacement, applicationAccess: { kind: 'scoped-worker-mcp',
          token: 'unit-main-owned-token', executionId: f.intent.executionId, agentId: f.request.configuration.agentId,
          operationId: f.intent.operationId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash } })
      pending.push(...Array.from({ length: 8 }, () => worker.request(EXECUTION_AUTHORITY_EXTENSION.namespace, 'occupied')))
      for (const request of pending) void request.catch(() => {
        // ignore: all requests are drained during cleanup.
      })
      await occupied.promise
      const queued = worker.request(EXECUTION_AUTHORITY_EXTENSION.namespace, 'ordinary')
      pending.push(queued)
      expect(entered).toBe(8)
      expect(authority.mock.calls.some(([payload]) => payload === 'ordinary')).toBe(false)
      const status = await f.journal.status(f.intent.operationId)
      if (status.status !== 'known') throw new Error('Expected original operation')
      const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
        operationId: f.intent.operationId, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
        bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: status.receipt.native, action: { kind: 'stop' } }
      const frame = { method: 'control', intent: f.intent, placement: f.placement, command }
      const originalAuthority = authority.getMockImplementation()!
      authority.mockImplementation(async payload => {
        const parsed = ExecutionAuthorityRequestSchema.safeParse(payload)
        if (parsed.success && parsed.data.action === 'stop') throw new Error('Original grant revoked')
        return originalAuthority(payload)
      })
      await expect(main.request('execution-v1', frame)).rejects.toThrow()
      expect(cancel).not.toHaveBeenCalled()
      authority.mockImplementation(originalAuthority)
      await expect(main.request('execution-v1', frame)).resolves.toMatchObject({ payload: { status: 'known',
        receipt: { phase: 'confirmed_terminal', terminal: { kind: 'cancelled' } } } })
      expect(cancel).toHaveBeenCalledOnce()
      expect(create).toHaveBeenCalledOnce()
      expect(entered).toBe(8)
      expect(authority.mock.calls.some(([payload]) => payload === 'ordinary')).toBe(false)
      release.resolve()
      await expect(queued).resolves.toMatchObject({ payload: expect.anything() })
      expect(authority.mock.calls.some(([payload]) => payload === 'ordinary')).toBe(true)
      expect(authority.mock.calls.filter(([raw]) => {
        const parsed = ExecutionAuthorityRequestSchema.safeParse(raw)
        return parsed.success && parsed.data.action === 'stop'
      }).length).toBeGreaterThan(1)
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      parent.abort()
      await Promise.allSettled(readers)
      await f.host.close()
    }
  })

  it('delivers original history, ACK and Stop while another execution waits for Main facts', async () => {
    const f = await constructionFixture()
    const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockResolvedValue(f.session)
    vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => f.registry.scope(owner))
    vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
      residency: { session: f.session, connectionId: 'unit-native-connection', runtimeGeneration: 1, nativeTurnId: undefined },
      assertCurrent: () => {},
    })
    vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => ({
      endpoint: 'http://unit.invalid/mcp', close: async () => {}, bindRelay: async () => {}, refreshLease: () => relay.refresh!(),
    }))
    const history = { events: [], pendingInteractions: [], correlationId: `execution:${f.intent.executionId}` }
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockResolvedValue(history)
    const cancel = vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockResolvedValue(true)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockResolvedValue(undefined)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
    vi.spyOn(f.registry, 'closeRegistration').mockResolvedValue(undefined)
    const closeOwner = vi.spyOn(f.registry, 'closeOwner').mockImplementation(async () => {
      f.snapshot.mockReturnValue({ revision: 'snapshot:closed', launches: [{ ...f.launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }] })
      return true
    })
    const access = { kind: 'scoped-worker-mcp', token: 'unit-main-owned-token', executionId: f.intent.executionId,
      agentId: f.request.configuration.agentId, operationId: f.intent.operationId, attemptId: f.intent.attemptId,
      bindingHash: f.intent.bindingHash }
    const delayed = delayedFacts(f.readMain, 'other-execution')
    let pending: Promise<unknown> | undefined
    let responsive: Promise<unknown> | undefined
    try {
      await f.handler({ method: 'prepare', intent: f.intent, placement: f.placement, request: f.request,
        executionPlacement: f.nativePlacement, applicationAccess: access }, f.context)
      const status = await f.journal.status(f.intent.operationId)
      if (status.status !== 'known' || !status.receipt.native) throw new Error('Expected original native receipt')
      f.readMain.mockClear()
      await expect(f.handler({ method: 'physical-readout', intent: f.intent, placement: f.placement,
        receiptSequence: status.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }) }, f.context))
        .resolves.toMatchObject({ payload: { session: f.session } })
      expect(f.readMain).toHaveBeenCalledTimes(2)
      const other = { ...f.intent, executionId: 'other-execution', attemptId: 'other-attempt', operationId: 'other-operation' }
      pending = f.handler({ method: 'prepare', intent: other, placement: f.placement,
        request: { ...f.request, executionId: other.executionId }, executionPlacement: f.nativePlacement }, f.context)
      const rejected = expect(pending).rejects.toThrow('Delayed qualification rejected')
      await delayed.entered.promise
      responsive = (async () => {
        expect(await f.handler({ method: 'history', intent: f.intent, placement: f.placement }, f.context))
          .toMatchObject({ payload: { history } })
        expect(await f.handler({ method: 'physical-ack', intent: f.intent, placement: f.placement,
          receiptSequence: status.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }) }, f.context))
          .toMatchObject({ payload: { status: 'retired' } })
        return f.handler({ method: 'control', intent: f.intent, placement: f.placement, command: {
          schemaVersion: 1, protocolVersion: 1, commandId: 'original-stop', operationId: f.intent.operationId,
          executionId: f.intent.executionId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash,
          owner: f.intent.owner, native: status.receipt.native, action: { kind: 'stop' },
        } }, f.context)
      })()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([responsive, new Promise(resolve => { timeout = setTimeout(() => resolve('blocked'), 1000) })])
        expect(result).toMatchObject({ payload: { status: 'known', receipt: { terminal: { kind: 'cancelled' } } } })
        expect(cancel).toHaveBeenCalledOnce()
        expect(cancel).toHaveBeenCalledWith(f.session, undefined, undefined)
        expect(closeOwner).toHaveBeenCalledWith(`execution:${f.intent.executionId}`)
        expect(create).toHaveBeenCalledOnce()
      } finally { clearTimeout(timeout) }
      delayed.release.resolve()
      await rejected
    } finally {
      delayed.release.resolve()
      await Promise.allSettled([pending, responsive])
      await f.host.close()
    }
  })

  it('coalesces only matching execution construction and releases a rejected lookup for retry', async () => {
    const f = await constructionFixture()
    const delayed = delayedFacts(f.readMain, f.intent.executionId)
    const frame = { method: 'status', intent: f.intent, placement: f.placement }
    const tasks: Promise<unknown>[] = []
    try {
      tasks.push(f.handler(frame, f.context))
      const rejected = expect(tasks[0]).rejects.toThrow('Delayed qualification rejected')
      await delayed.entered.promise
      tasks.push(f.handler(frame, f.context))
      const duplicateRejected = expect(tasks[1]).rejects.toThrow('Delayed qualification rejected')
      await expect(f.handler({ ...frame, intent: { ...f.intent, owner: { grantId: 'foreign-grant', epoch: '2' } } }, f.context))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      await expect(f.handler({ ...frame, placement: { ...f.placement,
        destination: { ...f.placement.destination, canonicalCwd: '/foreign-cwd' } } }, f.context))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      const replacement = { ...f.context.binding, connectionEpoch: randomUUID() }
      f.currentBinding.mockReturnValue(replacement)
      await expect(f.handler(frame, { ...f.context, binding: replacement }))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      f.currentBinding.mockReturnValue(f.context.binding)
      expect(f.readMain).toHaveBeenCalledOnce()
      delayed.release.resolve()
      await Promise.all([rejected, duplicateRejected])
      delayed.restore()
      await expect(f.handler(frame, f.context)).resolves.toMatchObject({ payload: { status: 'unknown' } })
      expect(f.readMain.mock.calls.filter(([raw]) => ExecutionFactsRequestSchema.safeParse(raw).success)).toHaveLength(2)
    } finally {
      delayed.release.resolve()
      await Promise.allSettled(tasks)
      await f.host.close()
    }
  })

  it('refuses aborted construction before inspection or Main requests', async () => {
    const f = await constructionFixture()
    const controller = new AbortController()
    controller.abort(new Error('RPC already aborted'))
    try {
      await expect(f.handler({ method: 'status', intent: f.intent, placement: f.placement }, { ...f.context, signal: controller.signal }))
        .rejects.toThrow('RPC already aborted')
      expect(f.inspect).not.toHaveBeenCalled()
      expect(f.readMain).not.toHaveBeenCalled()
    } finally { await f.host.close() }
  })

  it('shares one generation host when separate constructions await the same journal', async () => {
    const f = await constructionFixture()
    const opened = deferred()
    const release = deferred()
    f.openJournal.mockImplementation(async () => { opened.resolve(); await release.promise; return f.journal })
    const other = { ...f.intent, executionId: 'other-execution', attemptId: 'other-attempt', operationId: 'other-operation' }
    const tasks = [f.intent, other].map(intent => f.handler({ method: 'status', intent, placement: f.placement }, f.context))
    try {
      await opened.promise
      release.resolve()
      await Promise.all(tasks)
      expect(f.inspect).toHaveBeenCalledTimes(4)
      expect(f.openJournal).toHaveBeenCalledOnce()
      const receipts = []
      for (const intent of [f.intent, other]) {
        await f.handler({ method: 'control', intent, placement: f.placement, command: {
          schemaVersion: 1, protocolVersion: 1, commandId: `stop:${intent.executionId}`,
          operationId: intent.operationId, executionId: intent.executionId, attemptId: intent.attemptId,
          bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' },
        } }, f.context)
        const status = await f.journal.status(intent.operationId)
        if (status.status !== 'known') throw new Error('Expected retained Stop receipt')
        receipts.push(status.receipt)
      }
      expect(receipts[0]!.workerIncarnationId).toBe(receipts[1]!.workerIncarnationId)
      expect(receipts.every(receipt => receipt.stopFence && !receipt.entryAttempted)).toBe(true)
    } finally {
      release.resolve()
      await Promise.allSettled(tasks)
      await f.host.close()
    }
  })

  it('joins only the cleanup target construction while unrelated facts are delayed', async () => {
    const f = await constructionFixture()
    f.snapshot.mockReturnValue({ revision: 'snapshot:empty', launches: [] })
    const other = { ...f.intent, executionId: 'other-execution', attemptId: 'other-attempt', operationId: 'other-operation' }
    const delayed = delayedFacts(f.readMain, other.executionId)
    const pending = f.handler({ method: 'status', intent: other, placement: f.placement }, f.context)
    const rejected = expect(pending).rejects.toThrow('Delayed qualification rejected')
    try {
      await delayed.entered.promise
      const owner = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const }
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([f.host.preparationClosed(owner), new Promise(resolve => {
          timeout = setTimeout(() => resolve('blocked'), 1000)
        })])
        expect(result).toBe(true)
      } finally { clearTimeout(timeout) }
      let targetClosed = false
      const target = f.host.preparationClosed({ ...owner,
        identity: { ...owner.identity, operationId: other.operationId },
        attempt: { ...owner.attempt, executionId: other.executionId, attemptId: other.attemptId },
      }).then(result => { targetClosed = true; return result })
      await Promise.resolve()
      expect(targetClosed).toBe(false)
      delayed.release.resolve()
      await rejected
      expect(await target).toBe(true)
    } finally {
      delayed.release.resolve()
      await Promise.allSettled([pending])
      await f.host.close()
    }
  })

  it('still requires Main control authorization for a constructed owner', async () => {
    const f = await constructionFixture()
    try {
      await f.handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context)
      f.deny()
      await expect(f.handler({ method: 'control', intent: f.intent, placement: f.placement, command: {
        schemaVersion: 1, protocolVersion: 1, commandId: 'denied-stop', operationId: f.intent.operationId,
        executionId: f.intent.executionId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash,
        owner: f.intent.owner, action: { kind: 'stop' },
      } }, f.context)).rejects.toThrow('Main denied original execution access')
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'unknown' })
    } finally { await f.host.close() }
  })
})


it('persists the original workflow account beside the native owner without adopting a changed binding on restart', async () => {
  const f = await restartedInstalledFixture()
  const receipt = await f.journal.status(f.intent.operationId)
  if (receipt.status !== 'known') throw new Error('Saved receipt required')
  const original = f.recovery.read(receipt.receipt)
  if (!original) throw new Error('Original native capture required')
  const binding: ProviderAccountBinding = { kind: 'slot', accountId: randomUUID(), provider: 'codex',
    profileRef: randomUUID(), bindingRevision: 1, subject: null,
    target: { hostRef: { kind: 'device', mainId: f.context.binding.mainId, deviceId: f.context.binding.deviceId },
      applicationInstallationId: f.context.binding.workerInstallationId,
      keyRevision: f.context.binding.keyRevision, authorizationRevision: f.context.binding.authorizationRevision } }
  const directory = join(f.root, 'account-recovery')
  const recovery = new InstalledWorkflowRecovery(directory, f.registry)
  recovery.remember({ ...original, accountBinding: binding })
  const restarted = new InstalledWorkflowRecovery(directory, f.registry)
  expect(restarted.read(receipt.receipt)).toMatchObject({ accountBinding: binding, session: original.session, native: original.native })
  expect(() => restarted.remember({ ...original, accountBinding: { ...binding, accountId: randomUUID() } }))
    .toThrow('capture changed')
  expect(restarted.read(receipt.receipt)?.accountBinding).toEqual(binding)
})
