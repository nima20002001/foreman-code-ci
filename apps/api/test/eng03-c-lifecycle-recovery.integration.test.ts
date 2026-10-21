import { describe, expect, it, vi } from 'vitest'
import { readCurrentExecutions, postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleFixtures } from './helpers/workflowLifecycleFixtures.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { ApprovalTransportFaults } from './helpers/eng06ApprovalFaults.js'

// Provider transport is deterministic; admission, capture, checkpointing and lifecycle writers remain real.
describe.skipIf(!postgresEnabled)('native workflow lifecycle: recovery', () => {
  const fixture = lifecycleFixtures()

  it('closes a cold waiting sibling without replaying its accepted predecessor', async () => {
    const faults = new ApprovalTransportFaults()
    const f = await fixture({
      recoverNativeProcesses: (executionId, signal) => faults.recoverNativeProcesses(executionId, signal),
    })
    const connection = f.provider.connection.bind(f.provider)
    vi.spyOn(f.provider, 'connection').mockImplementation(() => faults.wrap(connection()))
    await f.engine.start(f.f.run.id)
    const [first, sibling] = await f.pending()
    if (!first || !sibling) throw new Error('Expected both native waits')
    await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(first))
    const accepted = (await readCurrentExecutions(f.runs, f.f.run.id)).find((item) => item.id === first.executionId)!
    expect(accepted.result?.outcome).toBe('succeeded')
    const exact = await f.runs.getExecution(sibling.executionId!)
    faults.killOnRestart = true
    await f.engine.shutdown()
    const next = f.compose()
    await next.engine.resume(f.f.run.id)
    const resumed = await next.runs.get(f.f.run.id)
    expect({ state: resumed?.executionState, outcome: resumed?.outcome }).toEqual({ state: 'completed', outcome: 'failed' })
    expect(f.provider.closedSessions.has(sibling.nativeSessionId)).toBe(true)
    expect((await next.repository.get(sibling.id))?.status).toBe('canceled')
    expect((await next.runs.getExecution(sibling.executionId!))?.nativeSessionId).toBe(exact?.nativeSessionId)
    expect((await next.runs.getExecution(first.executionId!))?.result).toEqual(accepted.result)
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1 })
  }, 60000)
})
