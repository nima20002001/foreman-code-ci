import { expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ExecutionFactsRequestSchema } from '@foreman-code/contracts/execution-authority'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import { deferred } from '../../../../test/helpers/deferred.js'
import { constructionFixture } from './__tests__/installedWorkflowHost.js'
import * as workerMcpEndpoint from './workerMcpEndpoint.js'

it('keeps live preparation when a concurrent status read started before the resident was published', async () => {
  const f = await constructionFixture()
  // Open the shared journal without constructing the execution under test.
  const other = { ...f.intent, executionId: 'other-execution', operationId: 'other-operation', attemptId: 'other-attempt' }
  await f.handler({ method: 'status', intent: other, placement: f.placement }, f.context)
  const qualifying = deferred()
  const qualified = deferred()
  const nativeEntered = deferred()
  const nativeFinished = deferred()
  const recoveryRead = deferred()
  const resumeRead = deferred()
  const statusRequest = new AsyncLocalStorage<boolean>()
  const readMain = f.readMain.getMockImplementation()!
  f.readMain.mockImplementation(async raw => {
    if (ExecutionFactsRequestSchema.safeParse(raw).success) {
      qualifying.resolve()
      await qualified.promise
    }
    return readMain(raw)
  })
  const isRetired = f.journal.isRetired.bind(f.journal)
  vi.spyOn(f.journal, 'isRetired').mockImplementation(async operationId => {
    if (statusRequest.getStore()) {
      recoveryRead.resolve()
      await resumeRead.promise
    }
    return isRetired(operationId)
  })
  const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockImplementation(async () => {
    nativeEntered.resolve()
    await nativeFinished.promise
    return f.session
  })
  vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => f.registry.scope(owner))
  vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
    residency: { session: f.session, connectionId: 'unit-native-connection', runtimeGeneration: 1, nativeTurnId: undefined },
    assertCurrent: () => {},
  })
  vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => ({
    endpoint: 'http://unit.invalid/mcp', close: async () => {}, bindRelay: async () => {}, refreshLease: () => relay.refresh!(),
  }))
  vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
  const closed = { ...f.launch, lifecycle: 'closed' as const, closureEvidence: 'cgroup_v2_empty' as const }
  const closeOwner = vi.spyOn(f.registry, 'closeOwner').mockImplementation(async () => {
    f.snapshot.mockReturnValue({ revision: 'closed', launches: [closed] })
    return true
  })
  vi.spyOn(f.registry, 'closedRegistration').mockReturnValue(closed)
  const preparing = f.handler({ method: 'prepare', intent: f.intent, placement: f.placement, request: f.request,
    executionPlacement: f.nativePlacement, applicationAccess: { kind: 'scoped-worker-mcp', token: 'unit-main-owned-token',
      executionId: f.intent.executionId, agentId: f.request.configuration.agentId, operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash } }, f.context)
  const preparationOutcome = Promise.allSettled([preparing])
  let status: ReturnType<typeof f.handler> | undefined
  try {
    await qualifying.promise
    status = statusRequest.run(true, () => f.handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context))
    const statusOutcome = Promise.allSettled([status])
    // Construction is pending when status starts. Its first journal read stays delayed
    // until the original native preparation has entered.
    qualified.resolve()
    await Promise.race([recoveryRead.promise, nativeEntered.promise])
    await nativeEntered.promise
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known',
      receipt: { entryAttempted: true, stopFence: false } })
    resumeRead.resolve()
    await statusOutcome
    expect(closeOwner).not.toHaveBeenCalled()
    await expect(status).resolves.toMatchObject({ payload: { status: 'known', receipt: { entryAttempted: true } } })
    const receipt = await f.journal.status(f.intent.operationId)
    expect(receipt.status === 'known' && receipt.receipt.terminal).toBeUndefined()
    nativeFinished.resolve()
    await expect(preparing).resolves.toMatchObject({ payload: { session: f.session } })
    expect(create).toHaveBeenCalledOnce()
  } finally {
    qualified.resolve()
    resumeRead.resolve()
    nativeFinished.resolve()
    await Promise.allSettled([preparationOutcome, status])
    await f.host.close()
  }
})
