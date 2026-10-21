import { expect, it, vi } from 'vitest'
import { ExecutionFactsRequestSchema } from '@foreman-code/contracts/execution-authority'
import { deferred } from '../../../../test/helpers/deferred.js'
import { constructionFixture } from './__tests__/installedWorkflowHost.js'

it.each([false, true])('handles Stop during initial qualification with denied authority=%s', async denied => {
  const f = await constructionFixture()
  f.snapshot.mockReturnValue({ revision: 'unentered', launches: [] })
  const reserve = vi.spyOn(f.registry, 'reserveLaunch')
  const entered = deferred()
  const release = deferred()
  let qualificationSignal: AbortSignal | undefined
  const original = f.readMain.getMockImplementation()!
  f.readMain.mockImplementation(async (...args: unknown[]) => {
    const [raw, options] = args as [unknown, { signal?: AbortSignal } | undefined]
    if (ExecutionFactsRequestSchema.safeParse(raw).success) {
      qualificationSignal = options?.signal
      entered.resolve()
      await Promise.race([release.promise, new Promise<never>((_resolve, reject) => {
        qualificationSignal?.addEventListener('abort', () => reject(qualificationSignal!.reason), { once: true })
      })])
      qualificationSignal?.throwIfAborted()
    }
    return original(raw)
  })
  const preparing = f.handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context)
  const preparationResult = Promise.allSettled([preparing])
  let stopping: Promise<unknown> | undefined
  try {
    await entered.promise
    if (denied) f.deny()
    stopping = f.handler({ method: 'control', intent: f.intent, placement: f.placement, command: {
      schemaVersion: 1, protocolVersion: 1, commandId: 'stop-construction', operationId: f.intent.operationId,
      executionId: f.intent.executionId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash,
      owner: f.intent.owner, action: { kind: 'stop' },
    } }, f.context)
    let stopped = false
    const result = stopping.then(value => { stopped = true; return value }, error => { stopped = true; return error })
    await expect.poll(() => stopped, { timeout: 1000 }).toBe(true)
    if (denied) {
      expect(await result).toMatchObject({ message: 'Main denied original execution access' })
      expect(qualificationSignal?.aborted).toBe(false)
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'unknown' })
    } else {
      expect(await result).toMatchObject({ payload: { status: 'known', receipt: {
        stopFence: true, entryAttempted: false, terminal: { kind: 'not_started' },
      } } })
      expect(qualificationSignal?.aborted).toBe(true)
      expect((await preparationResult)[0]?.status).toBe('rejected')
    }
    expect(reserve).not.toHaveBeenCalled()
  } finally {
    release.resolve()
    await Promise.allSettled([preparing, stopping])
    await f.host.close()
  }
})
