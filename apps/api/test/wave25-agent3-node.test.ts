import { describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { repeatNodeAction, inactiveRepeatResolution, repeatTerminalResolution, type RepeatNodeStore } from '../src/modules/runs/repeatNode.js'
import type { RepeatResolution } from '../src/modules/runs/repeatResolution.js'
import { HarnessExecutionSchema } from '@foreman-code/contracts'

function fixture(suffix: string) {
  const f = makeCurrentWorkflowFixture(suffix)
  const executions = f.identities.map((identity) => HarnessExecutionSchema.parse({ workflowNodeId: identity.workflowNodeId, agentId: identity.agentId,
    agentConfigurationVersionId: identity.agentConfigurationVersionId, id: identity.executionId, runId: f.run.id, attempt: 1, input: {}, state: 'queued', createdAt: f.createdAt }))
  return { ...f, executions }
}

function setup(resolutionKind: 'skipped' | 'succeeded' = 'skipped') {
  const f = fixture('a3-node')
  const nodeId = f.executions[0]!.workflowNodeId
  const success = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt, result: { outcome: 'succeeded', output: 'done' } })
  const resolution = resolutionKind === 'skipped' ? inactiveRepeatResolution(f.version, { nodeId, occurrence: null }, 'skipped', f.createdAt) : repeatTerminalResolution(f.version, f.scope, { nodeId, occurrence: null }, success)
  const store = {
    admit: vi.fn<RepeatNodeStore['admit']>().mockResolvedValue({ kind: 'resolved', resolution }),
    acceptTerminal: vi.fn<RepeatNodeStore['acceptTerminal']>().mockResolvedValue({ kind: 'resolved', resolution }),
  }
  const driver = { candidate: vi.fn(() => f.executions[0]!), observe: vi.fn(async () => undefined) }
  const controller = new AbortController()
  return { f, nodeId, success, resolution, store, driver, controller, state: { runId: f.run.id, executionIds: {}, occurrences: {}, boundaries: {} } }
}

describe('Agent 3 lazy current V3 wrappers and bounded native capacity', () => {
  it('skips with no candidate, capacity wait, native resource or fabricated execution identity', async () => {
    const s = setup()
    const limiter = new ExecutionLimiter(1)
    const capacity = vi.spyOn(limiter, 'run')
    const action = repeatNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter, signal: s.controller.signal })
    expect(await action({ nodeId: s.nodeId, occurrence: null }, s.state)).toEqual({})
    expect(s.driver.candidate).not.toHaveBeenCalled()
    expect(s.driver.observe).not.toHaveBeenCalled()
    expect(capacity).not.toHaveBeenCalled()
  })
  it('repairs a terminal result after checkpoint failure without relaunching accepted work', async () => {
    const s = setup('succeeded')
    s.store.admit.mockResolvedValue({ kind: 'admitted', execution: s.success, reused: true })
    const action = repeatNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter: new ExecutionLimiter(1), signal: s.controller.signal })
    expect(await action({ nodeId: s.nodeId, occurrence: null }, s.state)).toEqual({ executionIds: { [s.nodeId]: { executionId: s.success.id, occurrenceId: null } } })
    expect(s.driver.observe).toHaveBeenCalledExactlyOnceWith(s.success, s.controller.signal)
    expect(s.driver.candidate).not.toHaveBeenCalled()
    expect(s.store.acceptTerminal).toHaveBeenCalledWith(s.success.id, expect.any(Function))
  })
  it('does not use a resolved checkpoint to activate the same execution again', async () => {
    const s = setup('succeeded')
    const action = repeatNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter: new ExecutionLimiter(1), signal: s.controller.signal })
    await action({ nodeId: s.nodeId, occurrence: null }, s.state)
    await action({ nodeId: s.nodeId, occurrence: null }, s.state)
    expect(s.driver.observe).not.toHaveBeenCalled()
    expect(s.store.acceptTerminal).not.toHaveBeenCalled()
  })
  it('rejects a different Run and unresolved joins without any native call', async () => {
    const s = setup()
    const action = repeatNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter: new ExecutionLimiter(1), signal: s.controller.signal })
    await expect(action({ nodeId: s.nodeId, occurrence: null }, { ...s.state, runId: 'other' })).rejects.toThrow()
    s.store.admit.mockResolvedValue({ kind: 'waiting' })
    await expect(action({ nodeId: s.nodeId, occurrence: null }, s.state)).rejects.toThrow()
    expect(s.driver.observe).not.toHaveBeenCalled()
  })
  it('commits queue admission before capacity wait; queued Stop never enters observe', async () => {
    const s = setup()
    const limiter = new ExecutionLimiter(1)
    let release!: () => void
    const blocker = limiter.run(new AbortController().signal, () => new Promise<void>((resolve) => { release = resolve }))
    s.store.admit.mockResolvedValue({ kind: 'admitted', execution: s.f.executions[0]!, reused: false })
    const action = repeatNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter, signal: s.controller.signal })
    const waiting = action({ nodeId: s.nodeId, occurrence: null }, s.state)
    await Promise.resolve(); await Promise.resolve()
    expect(s.store.admit).toHaveBeenCalledOnce()
    expect(s.driver.observe).not.toHaveBeenCalled()
    const rejected = expect(waiting).rejects.toThrow('stop')
    s.controller.abort(new Error('stop'))
    release()
    await blocker
    await rejected
    expect(s.driver.observe).not.toHaveBeenCalled()
  })
  it('retains FIFO capacity when an intervening waiter cancels', async () => {
    const limiter = new ExecutionLimiter(1, 3)
    const signal = new AbortController().signal
    let release!: () => void
    const order: number[] = []
    const first = limiter.run(signal, () => new Promise<void>((resolve) => { release = resolve }))
    const a = limiter.run(signal, async () => { order.push(1) })
    const canceled = new AbortController()
    const b = limiter.run(canceled.signal, async () => { order.push(2) })
    const rejected = expect(b).rejects.toThrow('stop')
    const c = limiter.run(signal, async () => { order.push(3) })
    canceled.abort(new Error('stop'))
    release()
    await Promise.all([first, a, c, rejected])
    expect(order).toEqual([1, 3])
  })
  it('bounds admission and does not leak a slot when a transferred waiter stops', async () => {
    const limiter = new ExecutionLimiter(1, 1)
    const normal = new AbortController().signal
    let release!: () => void
    const first = limiter.run(normal, () => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    const next = limiter.run(controller.signal, async () => undefined)
    await expect(limiter.run(normal, async () => undefined)).rejects.toThrow('RUNNER_ADMISSION_FULL')
    const rejected = expect(next).rejects.toThrow('stop')
    release()
    controller.abort(new Error('stop'))
    await Promise.all([first, rejected])
    await expect(limiter.run(normal, async () => 'available')).resolves.toBe('available')
  })
  it.each(['pass', 'issues'])('performs %s routing with zero/one Fixer observations', async (outcome) => {
    const f = fixture(`a3-${outcome}`)
    const root = f.version.definition.nodes[0]!, fixer = f.version.definition.nodes[1]!
    root.choice = { outcomes: [{ outcome: 'pass', target: { kind: 'branch_end' } },
      { outcome: 'issues', target: { kind: 'edge', relationshipId: f.version.definition.edges[0]!.id } }] }
    const completed = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output: { routing: { outcome }, data: {} } } })
    const rootResolution = repeatTerminalResolution(f.version, f.scope, { nodeId: root.id, occurrence: null }, completed)
    const fixerResolution: RepeatResolution = outcome === 'pass'
      ? inactiveRepeatResolution(f.version, { nodeId: fixer.id, occurrence: null }, 'skipped', f.createdAt)
      : repeatTerminalResolution(f.version, f.scope, { nodeId: fixer.id, occurrence: null }, HarnessExecutionSchema.parse({ ...f.executions[1], state: 'completed', finishedAt: f.createdAt, result: { outcome: 'succeeded', output: 'fixed' } }))
    expect(rootResolution.value.selectedRelationshipIds.length).toBe(outcome === 'pass' ? 0 : 1)
    const observe = vi.fn(async () => undefined)
    const action = repeatNodeAction({ runId: f.run.id, signal: new AbortController().signal, limiter: new ExecutionLimiter(1),
      driver: { candidate: () => f.executions[1]!, observe }, store: {
        admit: async () => outcome === 'pass' ? { kind: 'resolved', resolution: fixerResolution }
          : { kind: 'admitted', execution: f.executions[1]!, reused: false },
        acceptTerminal: async () => ({ kind: 'resolved', resolution: fixerResolution }),
      } })
    await action({ nodeId: fixer.id, occurrence: null }, { runId: f.run.id, occurrences: {}, boundaries: {},
      executionIds: { [root.id]: { executionId: completed.id, occurrenceId: null } } })
    expect(observe).toHaveBeenCalledTimes(outcome === 'pass' ? 0 : 1)
  })
})
