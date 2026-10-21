import { expect, it } from 'vitest'
import { CodexAppServerSessionManager } from './codexAppServer.js'
import type { WorkflowNativeSessionStart } from './port.js'
import { ActivityProductionReplay } from '../../../test/helpers/activityProductionReplay.js'
import { collect, input } from '../../../test/fixtures/codex-test-helpers.js'

async function closedWorkflow(previousTurn?: 'completed' | 'active') {
  const replay = new ActivityProductionReplay('continued-workflow')
  const infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Recorded provider I/O required')
  const managers: CodexAppServerSessionManager[] = []
  const createManager = () => {
    const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'scoped', undefined, infrastructure.codex)
    managers.push(manager)
    return manager
  }
  const original = createManager()
  const source = input('/recorded/workflow')
  source.correlationId = `execution:${source.request.executionId}`
  const session = await original.createSession(source)
  if (previousTurn) {
    replay.nextStart = previousTurn === 'completed' ? 'complete' : 'active'
    const stream = original.startTurn(session, { prompt: 'Finish the original execution',
      clientCorrelationId: source.correlationId! })
    if (previousTurn === 'completed') await collect(stream)
    else {
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.()
    }
  }
  await original.close(session)
  const continuation: WorkflowNativeSessionStart = { ...source,
    request: { ...source.request, executionId: 'continued-execution' }, correlationId: 'execution:continued-execution',
    sessionContinuation: { previousExecutionId: source.request.executionId, session } }
  return { replay, session, continuation, createManager,
    close: () => Promise.all(managers.map(manager => manager.dispose())) }
}

it('captures a newly admitted workflow continuation as its own original process lifetime', async () => {
  const f = await closedWorkflow()
  try {
    const manager = f.createManager()
    expect(await manager.createSession(f.continuation)).toEqual(f.session)
    const lifetime = manager.originalSessionLifetime(f.session, f.continuation)
    expect(lifetime).toBeDefined()
    lifetime!.assertCurrent()
    expect(f.replay.threads.size).toBe(1)
    expect(f.replay.starts).toEqual([])
    expect(f.replay.calls.filter(call => call.method === 'thread/resume')).toHaveLength(1)
    expect(await manager.createSession(f.continuation)).toEqual(f.session)
    expect(manager.originalSessionLifetime(f.session, f.continuation)?.residency).toEqual(lifetime!.residency)
    expect(f.replay.calls.filter(call => call.method === 'thread/resume')).toHaveLength(1)
    await manager.close(f.session)
    expect(() => lifetime!.assertCurrent()).toThrow()
  } finally { await f.close() }
})

it('observes an admitted continuation as idle before its first turn without adopting the previous result', async () => {
  const f = await closedWorkflow('completed')
  try {
    const manager = f.createManager()
    await manager.createSession(f.continuation)
    const history = await manager.reconcile(f.session, f.continuation.correlationId!)
    expect(history.terminalResult).toBeUndefined()
    expect(history.terminalTurn).toBeUndefined()
    expect(f.replay.starts).toHaveLength(1)
    f.replay.nextStart = 'complete'
    await collect(manager.startTurn(f.session, { prompt: 'Finish the continued execution',
      clientCorrelationId: f.continuation.correlationId! }))
    const completed = await manager.reconcile(f.session, f.continuation.correlationId!)
    expect(completed.terminalTurn).toMatchObject({ correlationId: f.continuation.correlationId,
      providerId: 'recorded-turn-2', result: { outcome: 'succeeded' } })
    expect(f.replay.starts.map(start => start.correlationId))
      .toEqual(['execution:execution-agent-a', f.continuation.correlationId])
  } finally { await f.close() }
})

it('refuses a continuation whose native history still has an active previous turn', async () => {
  const f = await closedWorkflow('active')
  try {
    await expect(f.createManager().createSession(f.continuation))
      .rejects.toMatchObject({ result: { error: { code: 'CODEX_SESSION_BUSY' } } })
    expect(f.replay.starts).toHaveLength(1)
  } finally { await f.close() }
})

it.each(['attach', 'create-after-attach'] as const)(
  'keeps cold %s ineligible for original residency even with a continuation descriptor', async mode => {
    const f = await closedWorkflow()
    try {
      const manager = f.createManager()
      expect(await manager.attachSession(f.session, f.continuation)).toEqual(f.session)
      if (mode === 'create-after-attach') expect(await manager.createSession(f.continuation)).toEqual(f.session)
      expect(manager.originalSessionLifetime(f.session, f.continuation)).toBeUndefined()
      expect(f.replay.starts).toEqual([])
    } finally { await f.close() }
  })
