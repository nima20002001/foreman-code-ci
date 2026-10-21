import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { deferred } from '../../../../test/helpers/deferred.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteWorkflowPhysicalOutput } from '@foreman-code/contracts/remote-workflow-physical'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { InstalledWorkflowRecovery } from './installedWorkflowRecovery.js'
import { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { restartedInstalledFixture, runningInstalledFixture, constructionFixture } from './__tests__/installedWorkflowHost.js'

it.each([false, true])('keeps recovered session ACKs readable until terminal history retirement (retire=%s)', async retire => {
  const f = await restartedInstalledFixture()
  await f.journal.close()
  const host = await f.startHost()
  const call = (method: string, fields: Record<string, unknown> = {}) => host.extensions[0]!.handle!({
    method, intent: f.intent, placement: f.placement, ...fields,
  }, f.context)
  try {
    const reply = await call('reattach', { session: f.session, request: f.request })
    const receipt = RemoteOperationReceiptSchema.parse((reply.payload as { status: { receipt: unknown } }).status.receipt)
    const selector = { receiptSequence: receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }) }
    expect((await call('physical-ack', { ...selector, ...(retire ? { retire: true } : {}) })).payload).toMatchObject({ status: 'retired' })
    const history = await call('history')
    expect(history.payload).toMatchObject({ status: { receipt } })
    const source = { type: 'history' as const, history: (history.payload as { history: never }).history }
    expect((await call('physical-ack', { receiptSequence: receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest(source), retire: true })).payload).toMatchObject({ status: 'retired' })
    await expect(call('history')).rejects.toThrow()
    expect((await call('status')).payload).toMatchObject({ receipt })
  } finally { await host.close() }
})

it.each([undefined, ['report']] as const)('persists complete physical output before exposing terminal settlement (%s)', async artifactOutputKeys => {
  const f = await runningInstalledFixture('generation', artifactOutputKeys ? { artifactOutputKeys: [...artifactOutputKeys] } : {})
  const recovery = new InstalledWorkflowRecovery(join(f.root, 'workflow-recovery'),
    new NativeProcessRegistry(join(f.root, 'native-processes')))
  const result = { outcome: 'succeeded' as const, output: { text: 'provider answer' } }
  try {
    f.finish('succeeded', result.output)
    await f.settled
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known' || !status.receipt.terminal) throw new Error('Expected terminal result')
    const declaration = f.placement.payload.kind === 'agent' ? f.placement.payload.artifactOutputs : undefined
    expect(await recovery.readOutput(f.intent.operationId)).toEqual(remoteWorkflowPhysicalOutput(
      result, declaration, status.receipt.terminal.artifactValidationError,
    ))
  } finally {
    f.finish('canceled')
    await f.host.close()
  }
})

it('refuses to invent artifact output when a recovered terminal has no saved output', async () => {
  const f = await restartedInstalledFixture()
  const result = { outcome: 'succeeded' as const, output: { text: 'artifact result' } }
  await f.journal.terminal(f.intent.operationId, { kind: 'completed', result,
    artifactDigests: ['a'.repeat(64)], resultDigest: 'b'.repeat(64), closureEvidenceDigest: 'c'.repeat(64) })
  await f.journal.close()
  const host = await f.startHost()
  try {
    await expect(host.extensions[0]!.handle!({ method: 'history', intent: f.intent,
      placement: f.placement }, f.context)).rejects.toThrow('Original workflow recovery output is missing')
  } finally { await host.close() }
})

it('cancels the installed Worker preflight request when Stop arrives', async () => {
  const f = await constructionFixture()
  vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => ({
    ...f.registry.scope(owner), launchId: f.launch.launchId,
  }))
  const closed = { ...f.launch, lifecycle: 'closed' as const, closureEvidence: 'cgroup_v2_empty' as const }
  vi.spyOn(f.registry, 'closeOwner').mockImplementation(async () => {
    f.snapshot.mockReturnValue({ revision: 'closed', launches: [closed] })
    return true
  })
  vi.spyOn(f.registry, 'closedRegistration').mockReturnValue(closed)
  vi.spyOn(f.registry, 'abandonReservedLaunch').mockResolvedValue(false)
  const entered = deferred()
  const release = deferred()
  let requestSignal: AbortSignal | undefined
  const original = f.readMain.getMockImplementation()!
  f.readMain.mockImplementation(async (...args: unknown[]) => {
    const [raw, options] = args as [unknown, { signal?: AbortSignal } | undefined]
    if ((raw as { operation?: string }).operation === 'worker-mcp.authorize') {
      requestSignal = options?.signal
      entered.resolve()
      await release.promise
      requestSignal?.throwIfAborted()
      throw new Error('Preflight request released')
    }
    return original(raw)
  })
  const preparing = f.handler({ method: 'prepare', intent: f.intent, placement: f.placement,
    executionPlacement: f.nativePlacement, request: f.request,
    applicationAccess: { kind: 'scoped-worker-mcp', token: 'unit-token', executionId: f.intent.executionId,
      agentId: f.request.configuration.agentId, operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash },
  }, f.context)
  const preparationResult = Promise.allSettled([preparing])
  let stopping: Promise<unknown> | undefined
  try {
    await Promise.race([entered.promise, preparing.then(() => {
      throw new Error('Preparation completed before preflight')
    })])
    stopping = f.handler({ method: 'control', intent: f.intent, placement: f.placement,
      command: { schemaVersion: 1, protocolVersion: 1, commandId: 'stop-preflight',
        operationId: f.intent.operationId, executionId: f.intent.executionId,
        attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, owner: f.intent.owner,
        action: { kind: 'stop' } },
    }, f.context)
    const stopped = Promise.allSettled([stopping])
    await expect.poll(() => requestSignal?.aborted, { timeout: 1000 }).toBe(true)
    release.resolve()
    await stopped
  } finally {
    release.resolve()
    await Promise.allSettled([preparing, stopping])
    await preparationResult
    await f.host.close()
  }
})

it('persists published artifact output before the terminal receipt is committed', async () => {
  const f = await runningInstalledFixture('generation', { artifactOutputKeys: ['report'] })
  if (!f.outputs) throw new Error('Expected native outputs')
  const configuration = f.request.configuration.harness
  if (configuration.harness !== 'codex') throw new Error('Expected Codex')
  const signal = new AbortController().signal
  const sandbox = { cwd: f.request.workingDirectory, writableRoots: [f.request.workingDirectory],
    networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: undefined }
  const bridge = await f.outputs.prepare({ configuration, binary: '/unit/codex', binaryIdentity: 'unit-binary',
    providerVersion: f.session.providerVersion, schemaIdentity: 'unit-schema',
    expectedSandbox: sandbox, effectiveSandbox: sandbox, session: f.session,
    clientCorrelationId: 'execution:execution', connectionId: 'native-connection', runtimeGeneration: 1 }, signal)
  const pin = { session: f.session, connectionId: 'native-connection', runtimeGeneration: 1,
    nativeTurnId: 'original-turn', assertCurrent() {} }
  const callback = () => ({ ...pin, rpcId: 'output-rpc', callId: randomUUID() })
  const recovery = new InstalledWorkflowRecovery(join(f.root, 'workflow-recovery'),
    new NativeProcessRegistry(join(f.root, 'native-processes')))
  let outputAtCommit: unknown
  const commit = vi.mocked(f.journal.terminal).getMockImplementation()!
  vi.spyOn(f.journal, 'terminal').mockImplementation(async (operationId, terminal) => {
    outputAtCommit = await recovery.readOutput(operationId)
    return commit(operationId, terminal)
  })
  try {
    await bridge.activate(pin, signal)
    const created = await bridge.dispatch({ operation: 'create', commandId: randomUUID(),
      filename: 'report.md', mediaType: 'text/markdown' }, callback(), signal)
    if (created.operation !== 'create') throw new Error('Expected artifact')
    await bridge.dispatch({ operation: 'append', commandId: randomUUID(), artifactId: created.artifactId,
      offset: 0, contentBase64: Buffer.from('workflow report').toString('base64') }, callback(), signal)
    await bridge.dispatch({ operation: 'seal', commandId: randomUUID(), artifactId: created.artifactId }, callback(), signal)
    const commandId = randomUUID()
    await bridge.dispatch({ operation: 'publish', publication: { commandId, artifactId: created.artifactId,
      filename: 'report.md', mediaType: 'text/markdown' } }, callback(), signal)
    f.finish('succeeded', { text: JSON.stringify({ data: { report: 'complete' }, artifactOutputs: {
      version: 1, outputs: [{ outputKey: 'report', commandId }],
    } }) })
    await f.settled
    expect(outputAtCommit).toMatchObject({ kind: 'published-artifacts',
      artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId }] } })
    const status = await f.journal.status(f.intent.operationId)
    expect(status).toMatchObject({ receipt: { terminal: { artifactDigests: [expect.any(String)] } } })
    expect(await recovery.readOutput(f.intent.operationId)).toEqual(outputAtCommit)
  } finally {
    f.finish('canceled')
    await f.host.close()
  }
})
