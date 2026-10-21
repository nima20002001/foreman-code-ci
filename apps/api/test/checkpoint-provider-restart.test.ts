import { HarnessExecutionRequestSchema, type NativeHarnessEvent } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { CheckpointTestProvider } from './helpers/wave25Br1003Provider.js'

async function collectEvents(stream: AsyncIterable<NativeHarnessEvent>): Promise<NativeHarnessEvent[]> {
  const events: NativeHarnessEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function idleSession() {
  const workflow = makeCurrentWorkflowFixture('checkpoint-restart', 'single')
  const request = HarnessExecutionRequestSchema.parse({
    executionId: 'checkpoint-idle-execution',
    runId: workflow.run.id,
    workspaceId: workflow.scope.workspaceId,
    workflowNodeId: workflow.version.entryNodeId,
    workingDirectory: '/synthetic/checkpoint-workspace',
    runtimeDirectory: '/synthetic/checkpoint-runtime',
    input: {},
    configuration: workflow.configurations[0],
  })
  const provider = new CheckpointTestProvider(new Set())
  const manager = provider.connection()
  const start = { request }
  const session = await manager.createSession(start)
  const turn = { prompt: 'Submit this initial input once', clientCorrelationId: `execution:${request.executionId}` }
  return { provider, manager, start, session, turn }
}

it('detaches a saved idle session and reattaches its original identity before one initial submission', async () => {
  const fixture = await idleSession()
  expect(fixture.manager.canDetachForRestart?.(fixture.session)).toBe(true)
  expect(await fixture.manager.reconcile(fixture.session, fixture.turn.clientCorrelationId))
    .not.toHaveProperty('nativeTurnId')
  const queuedTurn = fixture.manager.startTurn(fixture.session, fixture.turn)
  await fixture.manager.closeForRestart!(fixture.session)
  expect(fixture.provider.closedSessions.has(fixture.session.nativeSessionId)).toBe(true)
  expect(fixture.manager.canDetachForRestart?.(fixture.session)).toBe(false)
  await expect(collectEvents(queuedTurn)).rejects.toThrow('does not own a live session')
  expect(fixture.provider.counts.starts).toBe(0)
  const restored = fixture.provider.connection()
  try {
    const session = await restored.attachSession(fixture.session, fixture.start)
    expect(session).toEqual(fixture.session)
    expect(restored.canDetachForRestart?.(session)).toBe(true)
    expect(fixture.manager.canDetachForRestart?.(fixture.session)).toBe(false)
    await expect(collectEvents(fixture.manager.startTurn(fixture.session, fixture.turn)))
      .rejects.toThrow('does not own a live session')
    const events = await collectEvents(restored.startTurn(session, fixture.turn))
    expect(events.map(event => event.type)).toEqual(['turn.started', 'turn.completed'])
    expect(fixture.provider.counts).toMatchObject({ sessions: 1, attaches: 1, starts: 1 })
    expect(await restored.reconcile(session, fixture.turn.clientCorrelationId))
      .toMatchObject({ nativeTurnId: `turn-${fixture.start.request.executionId}` })
    await expect(collectEvents(restored.startTurn(session, fixture.turn))).rejects.toThrow('was replayed')
    expect(fixture.provider.counts.starts).toBe(1)
  } finally {
    await restored.dispose!()
    await fixture.manager.dispose!()
  }
})

it('requires the current connection and matching live session identity for idle detachment', async () => {
  const fixture = await idleSession()
  const other = fixture.provider.connection()
  try {
    expect(other.canDetachForRestart?.(fixture.session)).toBe(false)
    expect(fixture.manager.canDetachForRestart?.({ ...fixture.session, nativeSessionId: 'unknown-session' })).toBe(false)
    expect(fixture.manager.canDetachForRestart?.({ ...fixture.session, providerVersion: 'different-version' })).toBe(false)
    expect(fixture.manager.canDetachForRestart?.({ ...fixture.session, harness: 'claude' })).toBe(false)
    await fixture.manager.close(fixture.session)
    expect(fixture.manager.canDetachForRestart?.(fixture.session)).toBe(false)
    await other.attachSession(fixture.session, fixture.start)
    expect(fixture.manager.canDetachForRestart?.(fixture.session)).toBe(false)
    expect(other.canDetachForRestart?.(fixture.session)).toBe(true)
    await other.dispose!()
    expect(other.canDetachForRestart?.(fixture.session)).toBe(false)
  } finally {
    await other.dispose!()
    await fixture.manager.dispose!()
  }
})

it('denies idle detachment after the original execution offers its first turn', async () => {
  const fixture = await idleSession()
  try {
    await collectEvents(fixture.manager.startTurn(fixture.session, fixture.turn))
    expect(fixture.manager.canDetachForRestart?.(fixture.session)).toBe(false)
    expect(fixture.provider.counts.starts).toBe(1)
  } finally {
    await fixture.manager.dispose!()
  }
})
