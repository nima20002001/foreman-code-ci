import { randomUUID } from 'node:crypto'
import { chmod, symlink, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NativeHistory } from '../../harnesses/port.js'
import type { CodexNativeOutputTurnPin } from '../../harnesses/codexNativeOutput.js'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import * as codexProtocol from '../../harnesses/codexProtocol.js'
import * as codexQualification from '../../harnesses/codexQualification.js'
import { fixtureProtocol } from '../../../../test/fixtures/codex-test-helpers.js'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { readRemoteReceiptResponse } from './installedWorkflowResponsePages.js'
import { type NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { readInstalledWorkflowConfiguration } from './installedWorkflowConfiguration.js'
import {
  captureInstalledWorkflowNativeOwner,
  settleInstalledWorkflowNativeOwner,
  attestInstalledWorkflowRuntimeLeaf,
} from './installedWorkflowHost.js'
import { sourceSha256 } from '../../sources/manifest.js'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { MainClock } from '../../devices/workerClock.js'
import {
  journals,
  directory,
  nativeFixture,
  closureFixture,
  sourceFixture,
  runningInstalledFixture,
} from './__tests__/installedWorkflowHost.js'

it('passes the qualified model inspection through the installed Worker while retaining launch authorization', async () => {
  const f = await runningInstalledFixture()
  const configuration = f.request.configuration.harness
  if (configuration.harness !== 'codex') throw new Error('Expected Codex configuration')
  const qualified: codexProtocol.QualifiedCodex = {
    binary: join(f.root, 'codex'), identity: 'fixture-binary', protocol: fixtureProtocol,
    providerVersion: '0.132.0', schemaManifestSha256: 'fixture-schema',
    stableSchemaGitBlob: '', referenceSchemaManifestSha256: '',
  }
  const qualify = vi.spyOn(codexProtocol, 'qualifyCodex').mockResolvedValue(qualified)
  const model = vi.spyOn(codexQualification, 'qualifyNativeCodexModel').mockResolvedValue(undefined)
  const manager = f.create.mock.contexts[0] as CodexAppServerSessionManager
  try {
    await manager.qualifyConfiguration(configuration, f.request.workingDirectory)
    expect(qualify).toHaveBeenCalledTimes(1)
    expect(model).toHaveBeenCalledTimes(1)
    const inspection = model.mock.calls[0]![6]
    expect(inspection?.qualified).toBe(qualified)
    expect(inspection?.assertUnchanged).toBeTypeOf('function')
    expect(inspection?.runCommand).toBeTypeOf('function')
    expect(inspection?.transportFactory).toBeTypeOf('function')
    expect(model.mock.calls[0]![5]?.owner).toBe(`execution:${f.intent.executionId}`)

    f.revoke()
    await expect(manager.qualifyConfiguration(configuration, f.request.workingDirectory))
      .rejects.toThrow('Launch authority revoked')
    expect(qualify).toHaveBeenCalledTimes(1)
    expect(model).toHaveBeenCalledTimes(1)
  } finally {
    f.finish('canceled')
    await f.host.close()
  }
})

describe('protected workflow selection without invented qualification',()=>{
  it('has no default installed selection when no explicit configuration is supplied',async()=>{
    expect(await readInstalledWorkflowConfiguration(null)).toBeNull()
  })
  it('reads only executable selection and rejects manually supplied qualification/readiness flags',async()=>{
    const root=await directory(),path=join(root,'workflow.json'),selection={schemaVersion:1,codexBinary:'/installed/codex',appMcpLauncher:'/installed/launcher.mjs',expectedVersion:'codex-cli 0.132.0',payloadPaths:[]}
    const location={path,ownerUid:process.getuid!()}
    await writeFile(path,JSON.stringify(selection),{mode:0o600})
    expect(await readInstalledWorkflowConfiguration(location)).toEqual(selection)
    await writeFile(path,JSON.stringify({...selection,qualified:true}))
    await expect(readInstalledWorkflowConfiguration(location)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
  })
  it('refuses symlinked and permissive configuration files',async()=>{
    const root=await directory(),path=join(root,'selection.json'),link=join(root,'redirect.json')
    await writeFile(path,JSON.stringify({schemaVersion:1,codexBinary:'/installed/codex',appMcpLauncher:'/installed/launcher.mjs',expectedVersion:'codex-cli 0.154.0',payloadPaths:[]}),{mode:0o600})
    await symlink(path,link)
    await expect(readInstalledWorkflowConfiguration({path:link,ownerUid:process.getuid!()})).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    await chmod(path,0o644)
    await expect(readInstalledWorkflowConfiguration({path,ownerUid:process.getuid!()})).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
  })
})

describe('exact installed workflow native owner observations',()=>{
  it('rejects a retired OpenCode session before reading any native owner', () => {
    const f = nativeFixture()
    expect(() => captureInstalledWorkflowNativeOwner(f.registry, f.connection, f.intent, {
      harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'saved-opencode-session',
    })).toThrowError(expect.objectContaining({
      code: 'HARNESS_RETIRED', message: 'OpenCode is retired and cannot execute. Select Codex or Claude for new work.',
    }))
    expect(f.snapshot).not.toHaveBeenCalled()
  })
  it('binds the session to the unique actual execution guardian/provider generation',()=>{
    const f=nativeFixture(),first=captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session)
    expect(first.native.sessionId).toBe(f.session.nativeSessionId)
    expect(first.launch).toEqual(f.launch)
    f.snapshot.mockReturnValue({revision:'snapshot:2',launches:[{...f.launch,provider:{pid:201,startTicks:'other-generation'}}]})
    expect(captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session).native.processIdentityDigest).not.toBe(first.native.processIdentityDigest)
  })
  it.each(['missing','ambiguous','foreign-owner','foreign-boot','missing-provider','missing-containment'] as const)('does not invent native precision for %s evidence',kind=>{
    const f=nativeFixture()
    const broken={...f.launch}
    if(kind==='foreign-owner')broken.owner='execution:foreign'
    if(kind==='foreign-boot')broken.bootId=randomUUID()
    if(kind==='missing-provider')delete broken.provider
    if(kind==='missing-containment')delete broken.boundary
    const launches:NativeLaunchObservation[]=kind==='missing'?[]:kind==='ambiguous'?[f.launch,{...f.launch,launchId:randomUUID()}]:[broken]
    f.snapshot.mockReturnValue({revision:'snapshot:2',launches})
    expect(()=>captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session)).toThrow('unavailable')
  })
})

describe('positive installed native closure consumption',()=>{
  it('retains the original physical owner after the Orchestrator workflow turn settles', async () => {
    const f = await closureFixture()
    expect(await settleInstalledWorkflowNativeOwner({ ...f,
      retainReviewer: { agentId: 'agent', expiresAt: new Date(Date.now() + 60_000).toISOString() } })).toBeNull()
    expect(f.close).not.toHaveBeenCalled()
    expect(f.closeOwner).not.toHaveBeenCalled()
    const status = await f.journal.status(f.intent.operationId)
    expect(status).toMatchObject({ status: 'known', receipt: {
      retainedReviewer: { agentId: 'agent', workflowTurnId: 'original-turn', result: { outcome: 'succeeded' } },
      native: { sessionId: f.session.nativeSessionId, processIdentityDigest: f.captured.native.processIdentityDigest },
    } })
    expect(status.status === 'known' && status.receipt.terminal).toBeUndefined()
  })
  it('closes the retained original owner on Run disposition without replacing its workflow result', async () => {
    const f = await closureFixture()
    await settleInstalledWorkflowNativeOwner({ ...f,
      retainReviewer: { agentId: 'agent', expiresAt: new Date(Date.now() + 60_000).toISOString() } })
    await f.journal.revokeFence(f.intent.operationId)
    f.closeOwner.mockResolvedValue(true)
    const result = await settleInstalledWorkflowNativeOwner({ ...f,
      history: { events: [], pendingInteractions: [], terminalTurn: {
        correlationId: 'assigned-review', providerId: 'review-turn', result: { outcome: 'succeeded' },
      } } })
    expect(result).toMatchObject({ kind: 'cancelled' })
    expect(result?.result).toBeUndefined()
    expect(f.close).toHaveBeenCalledExactlyOnceWith(f.session)
    expect(f.closeOwner).toHaveBeenCalledExactlyOnceWith(`execution:${f.intent.executionId}`)
  })
  it('does not retain a closed physical owner or an expired reviewer lifetime', async () => {
    const f = await closureFixture()
    await expect(settleInstalledWorkflowNativeOwner({ ...f,
      retainReviewer: { agentId: 'agent', expiresAt: new Date(Date.now() - 1).toISOString() } })).rejects.toThrow()
    expect(f.close).not.toHaveBeenCalled()
    expect(f.closeOwner).not.toHaveBeenCalled()
  })
  it('does not promote provider success when the original physical owner closure is unconfirmed',async()=>{
    const f=await closureFixture()
    expect(await settleInstalledWorkflowNativeOwner(f)).toBeNull()
    expect(f.closeOwner).toHaveBeenCalledWith('execution:execution')
    expect((await f.journal.status(f.intent.operationId)).status).toBe('known')
  })
  it('records only the original provider result after positive owner closure, and reuses an accepted terminal',async()=>{
    const f=await closureFixture();f.closeOwner.mockResolvedValue(true)
    const terminal=await settleInstalledWorkflowNativeOwner(f)
    expect(terminal).toMatchObject({kind:'completed',result:{outcome:'succeeded'}})
    if(!terminal)throw new Error('Expected unit closure evidence')
    await f.journal.terminal(f.intent.operationId,terminal)
    expect(await settleInstalledWorkflowNativeOwner(f)).toEqual(terminal)
    expect(f.close).toHaveBeenCalledOnce();expect(f.closeOwner).toHaveBeenCalledOnce()
  })
  it('refuses another turn result before any native closure mutation',async()=>{
    const f=await closureFixture();f.history.terminalTurn.providerId='foreign-turn'
    await expect(settleInstalledWorkflowNativeOwner(f)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    expect(f.close).not.toHaveBeenCalled();expect(f.closeOwner).not.toHaveBeenCalled()
  })
  it('does not infer a result or close an active execution from an empty native history',async()=>{
    const f=await closureFixture()
    expect(await settleInstalledWorkflowNativeOwner({...f,history:{events:[],pendingInteractions:[]}})).toBeNull()
    expect(f.close).not.toHaveBeenCalled();expect(f.closeOwner).not.toHaveBeenCalled()
  })
  it.each(['malformed-json', 'missing-key', 'missing-publication'] as const)(
    'closes and retains the original %s result through Stop and journal restart', async defect => {
      const f = await closureFixture()
      const artifactOutputs = { version: 1 as const, outputKeys: ['report'] }
      const mappings = { version: 1, outputs: [{ outputKey: 'report', commandId: 'original-publication' }] }
      const result = { outcome: 'succeeded' as const, output: { text: defect === 'malformed-json' ? '{'
        : JSON.stringify({ data: { original: true }, artifactOutputs: defect === 'missing-key'
          ? { version: 1, outputs: [{ outputKey: 'another', commandId: 'original-publication' }] } : mappings }) } }
      const history = { ...f.history, terminalTurn: { ...f.history.terminalTurn, result } }
      const original = structuredClone(history)
      const input = { ...f, history, artifactOutputs, publications: new Map() }
      // An unconfirmed physical owner stays pending regardless of invalid artifact data.
      expect(await settleInstalledWorkflowNativeOwner(input)).toBeNull()
      await f.journal.control({ schemaVersion: 1, protocolVersion: 1,
        commandId: 'original-stop', operationId: f.intent.operationId,
        attemptId: f.intent.attemptId, executionId: f.intent.executionId,
        bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } })
      f.closeOwner.mockResolvedValue(true)
      const terminal = await settleInstalledWorkflowNativeOwner(input)
      expect(terminal).toMatchObject({ kind: 'completed', result, artifactDigests: [],
        artifactValidationError: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT',
          reason: defect === 'missing-publication' ? 'missing_publication' : 'invalid_result' } })
      expect(history).toEqual(original)
      if (!terminal) throw new Error('Original native closure required')
      await f.journal.terminal(f.intent.operationId, terminal)
      await f.journal.close()
      const reopened = await RemoteOperationJournal.open(join(f.root, 'journal'))
      journals.push(reopened)
      f.close.mockClear()
      f.closeOwner.mockClear()
      expect(await settleInstalledWorkflowNativeOwner({ ...input, journal: reopened })).toEqual(terminal)
      expect((await reopened.status(f.intent.operationId))).toMatchObject({ status: 'known',
        receipt: { phase: 'confirmed_terminal', stopFence: true, terminal } })
      expect(f.close).not.toHaveBeenCalled()
      expect(f.closeOwner).not.toHaveBeenCalled()
    })
})

describe('installed host resident execution continuity', () => {
  it('validates ownership on polling and renews the MCP route only in its renewal window', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const f = await runningInstalledFixture()
    const mcpAuthorizations = () => f.requests.filter(request => request.namespace === 'worker-mcp-v2')
    const ownershipReads = () => f.requests.filter(request => request.namespace === 'execution-authority-v1'
      && (request.payload as { action: string }).action === 'read')
    try {
      const initialAuthorizations = mcpAuthorizations().length
      const initialReads = ownershipReads().length
      for (let index = 0; index < 3; index++) {
        expect((await f.call('history')).payload).toMatchObject({ history: { nativeTurnId: 'original-turn' } })
        expect((await f.call('status')).payload).toMatchObject({ status: 'known' })
      }
      expect(mcpAuthorizations()).toHaveLength(initialAuthorizations)
      expect(ownershipReads().length).toBeGreaterThan(initialReads)

      clock.mockReturnValue(now + 13 * 60_000)
      f.renew(new Date(now + 28 * 60_000).toISOString())
      await f.call('history')
      expect(mcpAuthorizations()).toHaveLength(initialAuthorizations + 1)
      await f.call('history')
      await f.call('status')
      expect(mcpAuthorizations()).toHaveLength(initialAuthorizations + 1)

      await expect(f.call('history', {}, { ...f.context.binding, connectionEpoch: randomUUID() }))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
    } finally {
      clock.mockRestore()
      f.cleanup()
      await f.stop()
      await f.host.close()
    }
  })

  it('answers Main status readback after Main refuses the MCP lease for good', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const f = await runningInstalledFixture()
    try {
      clock.mockReturnValue(now + 13 * 60_000)
      f.revokeMcpLease()
      for (let index = 0; index < 2; index++) {
        expect((await f.call('status')).payload).toMatchObject({ status: 'known' })
      }
    } finally {
      clock.mockRestore()
      f.cleanup()
      await f.stop()
      await f.host.close()
    }
  })

  it.each([-90_000, 50_000, 90_000])(
    'closes a retained reviewer at Main expiry through disconnect and a %s ms worker offset', async offset => {
      const mainTime = Date.now()
      let elapsed = 0
      const mainClock = new MainClock(() => elapsed)
      mainClock.observe(mainTime)
      const wallClock = vi.spyOn(Date, 'now').mockReturnValue(mainTime + offset)
      const f = await runningInstalledFixture('generation', {
        retainReviewer: true, mainNow: () => mainClock.now(),
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        f.finish('succeeded')
        await vi.waitFor(async () => expect(await f.journal.status(f.intent.operationId))
          .toMatchObject({ receipt: { retainedReviewer: { agentId: 'agent' } } }))
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
        f.disconnect()
        wallClock.mockReturnValue(mainTime + 300_000)
        elapsed = 10_000
        await vi.advanceTimersByTimeAsync(10_000)
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
        expect(await f.journal.status(f.intent.operationId)).toMatchObject({ receipt: {
          retainedReviewer: { expiresAt: new Date(mainTime + 60_000).toISOString() },
        } })
        expect(f.cancel).not.toHaveBeenCalled()
        wallClock.mockReturnValue(mainTime - 300_000)
        elapsed = 60_000
        await vi.advanceTimersByTimeAsync(10_000)
        await vi.waitFor(async () => expect(await f.journal.status(f.intent.operationId))
          .toMatchObject({ receipt: { terminal: { kind: 'cancelled' } } }))
        expect(f.cancel).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
        wallClock.mockRestore()
        f.reconnect(f.context.binding)
        f.cleanup()
        await f.stop()
        await f.host.close()
      }
    },
  )

  it('extends the reviewer deadline on successful Main renewal before a disconnection', async () => {
    const mainTime = Date.now()
    let elapsed = 0
    const mainClock = new MainClock(() => elapsed)
    mainClock.observe(mainTime)
    const f = await runningInstalledFixture('generation', { retainReviewer: true, mainNow: () => mainClock.now() })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      f.finish('succeeded')
      await vi.waitFor(async () => expect(await f.journal.status(f.intent.operationId))
        .toMatchObject({ receipt: { retainedReviewer: { agentId: 'agent' } } }))
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
      elapsed = 40_000
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(async () => expect(await f.journal.status(f.intent.operationId))
        .toMatchObject({ receipt: { retainedReviewer: {
          expiresAt: new Date(mainTime + 100_000).toISOString(),
        } } }))
      f.disconnect()
      elapsed = 60_000
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
      expect(f.cancel).not.toHaveBeenCalled()
      elapsed = 100_000
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(async () => expect(await f.journal.status(f.intent.operationId))
        .toMatchObject({ receipt: { terminal: { kind: 'cancelled' } } }))
    } finally {
      vi.useRealTimers()
      f.reconnect(f.context.binding)
      f.cleanup()
      await f.stop()
      await f.host.close()
    }
  })

  it.each(['status', 'reattach'] as const)(
    'reads the original retained reviewer through %s before App rebinding', async method => {
      const f = await runningInstalledFixture('generation', { retainReviewer: true })
      try {
        f.finish('succeeded')
        await f.retained
        f.denyMcp()
        const appRequests = f.requests.filter(request => request.namespace === 'worker-mcp-v2').length
        const reply = await f.call(method, method === 'reattach'
          ? { request: f.request, session: { harness: 'codex', providerVersion: '0.132.0', nativeSessionId: 'original-session' } }
          : {})
        expect(reply.payload).toMatchObject(method === 'reattach'
          ? { session: { nativeSessionId: 'original-session' }, status: { receipt: { retainedReviewer: { agentId: 'agent' } } } }
          : { receipt: { retainedReviewer: { agentId: 'agent' } } })
        expect(f.requests.filter(request => request.namespace === 'worker-mcp-v2')).toHaveLength(appRequests)
        expect(f.create).toHaveBeenCalledOnce()
        expect(f.attach).not.toHaveBeenCalled()
        expect((await f.call('history')).payload).toMatchObject({ history: { nativeTurnId: 'original-turn' } })
        expect(f.requests.filter(request => request.namespace === 'worker-mcp-v2')).toHaveLength(appRequests)
      } finally {
        f.cleanup()
        await f.stop()
        await f.host.close()
      }
    },
  )

  it('denies retained reviewer observation when Main retention authority is revoked', async () => {
    const f = await runningInstalledFixture('generation', { retainReviewer: true })
    try {
      f.finish('succeeded')
      await f.retained
      f.revokeRetention()
      await expect(f.call('status')).rejects.toThrow('Reviewer retention revoked')
    } finally {
      f.cleanup()
      await f.stop()
      await f.host.close()
    }
  })

  it('confirms source cleanup closure for a resident session stopped after its native turn started', async () => {
    const f = await runningInstalledFixture()
    try {
      await f.stop()
      await f.settled
      // The journal adds the started turn to the native identity; the process identity is unchanged.
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known',
        receipt: { stopFence: true, native: { sessionId: f.session.nativeSessionId, turnId: 'original-turn' } } })
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(false)
      const cleanup = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const }
      expect(await f.host.preparationClosed(cleanup)).toBe(true)
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
      // A retried reclamation reads back the same closure.
      expect(await f.host.preparationClosed(cleanup)).toBe(true)
    } finally {
      f.cleanup()
      await f.host.close()
    }
  })

  it.each(['status', 'reattach'] as const)('reads %s during committed cleanup without renewing the reviewer', async method => {
    const f = await runningInstalledFixture('generation', { retainReviewer: true })
    try {
      f.finish('succeeded')
      await f.retained
      f.cleanup()
      f.revokeRetention()
      const before = f.requests.length
      const fields = method === 'reattach' ? { session: f.session, request: f.request } : {}
      const reply = await f.call(method, fields)
      expect(reply.payload).toMatchObject(method === 'reattach'
        ? { session: f.session, status: { status: 'known' } } : { status: 'known' })
      expect(f.requests.slice(before).filter(request => request.namespace === 'execution-authority-v1'
        && (request.payload as { action: string }).action === 'retain-reviewer')).toHaveLength(0)
      await f.stop()
      await f.settled
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', stopFence: true },
      })
      expect(f.closeOwner).toHaveBeenCalled()
    } finally {
      f.cleanup()
      await f.stop()
      await f.host.close()
    }
  })

  it('reads the original native history during cleanup without renewing model-tool access', async () => {
    const f = await runningInstalledFixture()
    try {
      f.cleanup()
      const before = f.requests.filter(request => request.namespace !== 'execution-authority-v1').length
      expect(await f.call('history')).toMatchObject({ payload: { history: {
        correlationId: 'execution:execution', nativeTurnId: 'original-turn',
      } } })
      expect(f.requests.filter(request => request.namespace !== 'execution-authority-v1')).toHaveLength(before)
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.attach).not.toHaveBeenCalled()
      await expect(f.call('start-turn', { prompt: 'replacement', correlationId: 'execution:execution' }))
        .rejects.toThrow('Launch authority revoked')
    } finally {
      f.finish('canceled')
      await f.host.close()
    }
  })

  it('pages original large terminal receipts from the installed handler and its retired readback', async () => {
    const f = await runningInstalledFixture()
    const result = { outcome: 'succeeded' as const, output: { text: 'original 雪'.repeat(110_000) } }
    const read = async (method: string, fields: Record<string, unknown> = {}) => {
      const response = await f.call(method, fields)
      expect(Buffer.byteLength(JSON.stringify(response.payload))).toBeLessThanOrEqual(DEVICE_APPLICATION_JSON_BYTES)
      return readRemoteReceiptResponse(response.payload, f.intent, async request =>
        (await f.call('receipt-continuation', request)).payload)
    }
    try {
      f.finish('succeeded')
      f.history.terminalTurn!.result = result
      await f.settled
      expect(await read('status')).toMatchObject({ receipt: { terminal: { result } } })
      const history = await read('history') as { status: { receipt: { sequence: number; terminal: { result: unknown } } } }
      expect(history.status.receipt.terminal.result).toEqual(result)
      // A status reply refreshes the boundary retained for the same receipt.
      await read('status')
      await f.call('physical-ack', { retire: true, receiptSequence: history.status.receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'boundary' }) })
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
      expect(await read('status')).toMatchObject({ receipt: { terminal: { result } } })
      await expect(f.call('history')).rejects.toMatchObject({
        code: 'WORKER_WORKFLOW_UNAVAILABLE', details: { reason: 'original_operation_retired' },
      })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
    } finally { await f.host.close() }
  })

  it('keeps terminal history available after source acknowledgment until Main persists the execution result', async () => {
    const f = await runningInstalledFixture()
    try {
      f.finish('succeeded')
      await f.settled
      const response = await f.call('history')
      const value = response.payload as { history: NativeHistory; status: { receipt: { sequence: number } } }
      const selector = { receiptSequence: value.status.receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: value.history }) }
      await f.call('physical-ack', selector)
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(false)
      expect(await f.call('history')).toMatchObject({ payload: { history: value.history } })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
    } finally { await f.host.close() }
  })

  it('retires a completed owner when Main acknowledges a bounded terminal history page', async () => {
    const f = await runningInstalledFixture()
    try {
      f.history.events = Array.from({ length: 24 }, (_, sequence) => ({
        sequence, type: 'native.notification', occurredAt: new Date().toISOString(),
        payload: { text: 'x'.repeat(80_000) },
      }))
      f.history.firstRetainedSequence = 0
      f.history.nextSequence = 24
      f.finish('succeeded')
      await f.settled
      const response = await f.call('history')
      const value = response.payload as { history: NativeHistory; status: { receipt: { sequence: number } } }
      expect(value.history.events.length).toBeLessThan(f.history.events.length)
      const selector = { receiptSequence: value.status.receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: value.history }) }
      expect(await f.call('physical-ack', { ...selector, retire: true })).toMatchObject({ payload: { status: 'retired' } })
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
      expect(await f.call('status')).toMatchObject({ payload: { receipt: { terminal: { kind: 'completed' } } } })
      await expect(f.call('history')).rejects.toMatchObject({
        code: 'WORKER_WORKFLOW_UNAVAILABLE', details: { reason: 'original_operation_retired' },
      })
      expect(f.create).toHaveBeenCalledOnce()
    } finally {
      f.finish('canceled')
      await f.host.close()
    }
  })

  it('waits for original terminal settlement when reconnecting during native closure', async () => {
    const f = await runningInstalledFixture()
    const closeOwner = f.closeOwner.getMockImplementation()!
    let closed!: () => void
    let release!: () => void
    const physicallyClosed = new Promise<void>(resolve => { closed = resolve })
    const continueSettlement = new Promise<void>(resolve => { release = resolve })
    f.closeOwner.mockImplementation(async owner => {
      const result = await closeOwner(owner)
      closed()
      await continueSettlement
      return result
    })
    try {
      f.disconnect()
      f.finish('succeeded')
      await physicallyClosed
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'running' },
      })
      const replacement = { ...f.context.binding,
        connectionGeneration: f.context.binding.connectionGeneration + 1, connectionEpoch: randomUUID() }
      f.reconnect(replacement)
      let readSettled = false
      const outcome = f.call('history').then(response => ({ response }), (error: unknown) => ({ error }))
        .then(result => {
          readSettled = true
          return result
        })
      // Let reconnection inspect the closed process while its terminal commit is still blocked.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(readSettled).toBe(false)
      release()
      expect(await outcome).toMatchObject({ response: { payload: {
        history: f.history, status: { receipt: { terminal: { kind: 'completed' } } },
      } } })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.attach).not.toHaveBeenCalled()
      expect(f.cancel).not.toHaveBeenCalled()
    } finally {
      release()
      await f.host.close()
    }
  })

  it.each(['generation', 'approval wait'] as const)('rebinds %s to the original resident before history and Stop', async phase => {
    const f = await runningInstalledFixture(phase)
    try {
      const original = f.context.binding
      const originalConnection = DeviceConnectionIdentitySchema.strip().parse(original)
      f.disconnect()
      await expect(f.call('history', {}, original)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      const replacement = { ...original, connectionGeneration: original.connectionGeneration + 1, connectionEpoch: randomUUID() }
      f.reconnect(replacement)
      const read = await f.call('history')
      expect(read.payload).toMatchObject({ history: f.history, status: { receipt: {
        connection: originalConnection, native: { sessionId: 'original-session', turnId: 'original-turn' },
      } } })
      if (phase === 'approval wait') expect(f.history.pendingInteractions).toHaveLength(1)
      await expect(f.call('history', {}, original)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      await expect(f.stop()).resolves.toMatchObject({ payload: { receipt: { terminal: { kind: 'cancelled' } } } })
      expect(f.cancel).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'original-session' }), undefined, 'original-turn')
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.attach).not.toHaveBeenCalled()
      expect(f.requests.at(-1)?.binding).toEqual(replacement)
    } finally {
      f.finish('canceled')
      await f.host.close()
    }
  })

  it.each([
    ['reconnect', 'before create'], ['reconnect', 'after seal'],
    ['owner renewal', 'before create'], ['owner renewal', 'after seal'],
  ] as const)('publishes original artifacts after %s %s', async (change, stage) => {
    const f = await runningInstalledFixture('generation', { artifactOutputKeys: ['report'] })
    if (!f.outputs || !f.outputMain) throw new Error('Missing output composition')
    const outputMain = f.outputMain
    const configuration = f.request.configuration.harness
    if (configuration.harness !== 'codex') throw new Error('Expected Codex fixture')
    const sandbox = { cwd: f.request.workingDirectory, writableRoots: [f.request.workingDirectory],
      networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: undefined }
    const signal = new AbortController().signal
    const pin: CodexNativeOutputTurnPin = { session: f.session, connectionId: 'native-connection',
      runtimeGeneration: 1, nativeTurnId: 'original-turn', assertCurrent: () => {} }
    const bridge = await f.outputs.prepare({ configuration,
      binary: '/unit/codex', binaryIdentity: 'unit-binary', providerVersion: f.session.providerVersion,
      schemaIdentity: 'unit-schema', expectedSandbox: sandbox, effectiveSandbox: sandbox,
      session: f.session, clientCorrelationId: 'execution:execution',
      connectionId: pin.connectionId, runtimeGeneration: pin.runtimeGeneration }, signal)
    const callback = () => ({ ...pin, rpcId: 'output-rpc', callId: randomUUID() })
    const body = Buffer.from('# original workflow report\n')
    const seal = async () => {
      const created = await bridge.dispatch({ operation: 'create', commandId: randomUUID(),
        filename: 'report.md', mediaType: 'text/markdown' }, callback(), signal)
      if (created.operation !== 'create') throw new Error('Expected create reply')
      await bridge.dispatch({ operation: 'append', commandId: randomUUID(), artifactId: created.artifactId,
        offset: 0, contentBase64: body.toString('base64') }, callback(), signal)
      await bridge.dispatch({ operation: 'seal', commandId: randomUUID(), artifactId: created.artifactId }, callback(), signal)
      return created.artifactId
    }
    try {
      await bridge.activate(pin, signal)
      let artifactId = stage === 'after seal' ? await seal() : undefined
      const initial = await f.journal.status(f.intent.operationId)
      let binding = f.context.binding
      let intent = f.intent
      if (change === 'reconnect') {
        f.disconnect()
        binding = { ...binding, connectionGeneration: binding.connectionGeneration + 1, connectionEpoch: randomUUID() }
        f.reconnect(binding)
        await f.call('history')
        await expect(f.call('history', {}, f.context.binding)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      } else intent = await f.renewOwner()
      if (!artifactId) artifactId = await seal()
      const publication = { commandId: randomUUID(), artifactId, filename: 'report.md', mediaType: 'text/markdown' as const }
      outputMain.received.length = 0
      const reply = await bridge.dispatch({ operation: 'publish', publication }, callback(), signal)
      if (reply.operation !== 'publish') throw new Error('Expected publication reply')
      expect(reply.result.value.revision).toMatchObject({ byteSize: body.length, sha256: sourceSha256(body) })
      expect(reply.result.value.file.scope).toEqual(outputMain.files.scope)
      expect(await bridge.dispatch({ operation: 'publish', publication }, callback(), signal)).toEqual(reply)
      expect(outputMain.links.size).toBe(1)
      expect(outputMain.admissions.has(publication.commandId)).toBe(true)
      expect(outputMain.received.length).toBeGreaterThan(0)
      for (const request of outputMain.received) expect(request).toEqual({ binding, intent })
      const downloaded = await outputMain.files.files.download(outputMain.files.principal,
        { kind: 'agent', workspaceId: 'workspace', conversationId: outputMain.files.scope.chat.conversationId },
        { fileId: reply.result.value.file.fileId, revisionId: reply.result.value.revision.revisionId })
      const chunks: Buffer[] = []
      for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(body)
      const status = await f.journal.status(f.intent.operationId)
      if (initial.status !== 'known' || status.status !== 'known') throw new Error('Missing original receipt')
      expect(status.receipt.native).toEqual(initial.receipt.native)
      expect(status.receipt.connection).toEqual(initial.receipt.connection)
      expect(status.receipt.intent).toEqual(intent)
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.attach).not.toHaveBeenCalled()
      const handleMcp = outputMain.handleMcp
      vi.spyOn(outputMain, 'handleMcp').mockImplementationOnce(async (raw, capturedBinding) => {
        const response = await handleMcp(raw, capturedBinding)
        binding = { ...binding, connectionGeneration: binding.connectionGeneration + 1, connectionEpoch: randomUUID() }
        f.reconnect(binding)
        await f.call('history')
        return response
      })
      await expect(bridge.dispatch({ operation: 'publish', publication }, callback(), signal))
        .rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
      expect(await bridge.dispatch({ operation: 'publish', publication }, callback(), signal)).toEqual(reply)
      outputMain.files.revoke()
      await expect(bridge.dispatch({ operation: 'publish', publication }, callback(), signal)).rejects.toThrow('Revoked')
      expect(outputMain.links.size).toBe(1)
      f.finish('succeeded', { text: JSON.stringify({ data: { report: 'complete' }, artifactOutputs: {
        version: 1, outputs: [{ outputKey: 'report', commandId: publication.commandId }],
      } }) })
      await f.settled
      const completed = await f.journal.status(f.intent.operationId)
      expect(completed).toMatchObject({ receipt: { terminal: {
        kind: 'completed', artifactDigests: [sourceSha256(body)],
      } } })
      if (completed.status !== 'known') throw new Error('Missing settled receipt')
      expect(completed.receipt.terminal).not.toHaveProperty('artifactValidationError')
    } finally {
      await bridge.close()
      await outputMain.close()
      f.finish('canceled')
      await f.host.close()
    }
  })

  it.each(['process', 'boot', 'device', 'authorization'])('rejects changed %s on resident reconnection', async defect => {
    const f = await runningInstalledFixture()
    try {
      const replacement = { ...f.context.binding, connectionGeneration: 4, connectionEpoch: randomUUID() }
      if (defect === 'process') f.changeProcess()
      if (defect === 'boot') replacement.bootId = randomUUID()
      if (defect === 'device') replacement.deviceId = randomUUID()
      if (defect === 'authorization') replacement.authorizationRevision++
      f.reconnect(replacement)
      await expect(f.call('history')).rejects.toMatchObject({ code: defect === 'process'
        ? 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' : 'WORKER_WORKFLOW_UNAVAILABLE' })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.cancel).not.toHaveBeenCalled()
    } finally {
      f.reconnect(f.context.binding)
      f.finish('canceled')
      await f.host.close()
    }
  })

  it('reads completion produced offline after the original lease expiry without reopening the native or MCP process', async () => {
    const f = await runningInstalledFixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20 * 60_000)
    try {
      f.disconnect()
      f.renew(new Date(Date.now() + 15 * 60_000).toISOString())
      f.finish('succeeded')
      await f.settled
      f.reconnect({ ...f.context.binding, connectionGeneration: 4, connectionEpoch: randomUUID() })
      const history = await f.call('history')
      const receipt = (history.payload as { status: { receipt: { sequence: number } } }).status.receipt
      expect((await f.call('physical-readout', { receiptSequence: receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: f.history }) })).payload).toMatchObject({
        receipt: { terminal: { kind: 'completed' } }, closure: { ownerClosed: true },
      })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.attach).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
      await f.host.close()
    }
  })

  it.each(['completion', 'approval Stop'])('keeps physical readback after twenty minutes and %s', async ending => {
    const f = await runningInstalledFixture(ending === 'approval Stop' ? 'approval wait' : 'generation')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      for (const minute of [10, 20]) {
        clock.mockReturnValue(now + minute * 60_000)
        f.renew(new Date(Date.now() + 15 * 60_000).toISOString())
        await expect(f.call('history')).resolves.toMatchObject({ payload: { history: f.history } })
      }
      if (ending === 'approval Stop') await f.stop()
      else f.finish('succeeded')
      await f.settled
      const history = await f.call('history')
      const receipt = (history.payload as { status: { receipt: { sequence: number; terminal?: { kind: string } } } }).status.receipt
      const physical = await f.call('physical-readout', { receiptSequence: receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: f.history }) })
      expect(physical.payload).toMatchObject({ receipt: { terminal: { kind: ending === 'completion' ? 'completed' : 'cancelled' } },
        closure: { ownerClosed: true }, session: { nativeSessionId: 'original-session' } })
      expect(Date.parse((physical.payload as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now())
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
    } finally {
      clock.mockRestore()
      f.finish('canceled')
      await f.host.close()
    }
  })

  it.each(['permission', 'root policy'])('confirms original physical closure after %s changes revoke launch authority', async defect => {
    const f = await runningInstalledFixture('approval wait')
    try {
      f.revoke()
      if (defect === 'root policy') f.approvedRoots.managedRuntimeRoot = join(f.root, 'replacement-runtime')
      await expect(f.call('start-turn', { prompt: 'replacement', correlationId: 'execution:execution' })).rejects.toThrow('revoked')
      await expect(f.stop()).resolves.toMatchObject({ payload: { receipt: { terminal: { kind: 'cancelled' } } } })
      const history = await f.call('history')
      const receipt = (history.payload as { status: { receipt: { sequence: number } } }).status.receipt
      expect((await f.call('physical-readout', { receiptSequence: receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: f.history }) })).payload).toMatchObject({
        closure: { ownerClosed: true }, receipt: { stopFence: true, terminal: { kind: 'cancelled' } },
      })
      expect(f.closeOwner).toHaveBeenCalledWith('execution:execution')
      expect(f.cancel).toHaveBeenCalledOnce()
      expect(f.create).toHaveBeenCalledOnce()
    } finally {
      f.finish('canceled')
      await f.host.close()
    }
  })
})

describe('actual anchored runtime leaf filesystem',()=>{
  it('verifies retained source bytes and records its own sibling inode, with immutable retry readback',async()=>{
    const f=await sourceFixture(),proof=await attestInstalledWorkflowRuntimeLeaf(f)
    expect(proof.bindingHash).toBe(f.nativePlacement.bindingHash)
    expect(proof.directoryIdentityHash).not.toBe(f.nativePlacement.workingTree.directoryIdentityHash)
    expect(proof.materializationId).toBe(f.nativePlacement.materialization.receipt.materializationId)
    expect(await attestInstalledWorkflowRuntimeLeaf(f)).toEqual(proof)
    await writeFile(join(f.request.runtimeDirectory,'.graphql-workflow-runtime.json'),JSON.stringify({...proof,operationId:'foreign-operation'}))
    await expect(attestInstalledWorkflowRuntimeLeaf(f)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
  })
  it('rejects expired actual source ownership before creating a runtime leaf',async()=>{
    const f=await sourceFixture();f.owner.identity.expiresAt='2020-01-01T00:00:00.000Z'
    await expect(attestInstalledWorkflowRuntimeLeaf(f)).rejects.toThrow()
    await expect(access(f.request.runtimeDirectory)).rejects.toThrow()
  })
})
