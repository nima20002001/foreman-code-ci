import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { normalizeCodexNotification, type CodexNotificationEnvelope } from '../src/modules/harnesses/codexNormalization.js'
import { knownNativeActivity } from '../src/modules/conversations/knownNativeActivity.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { input } from './fixtures/codex-test-helpers.js'

// Hand-authored recorded protocol replay below the real adapter; no DB/provider qualification.
const command = { id: 'recorded-command', type: 'commandExecution', status: 'completed',
  command: 'printf recorded', cwd: '/recorded-workspace', aggregatedOutput: 'recorded output', exitCode: 0 }
const owner = { threadId: 'original-session', turnId: 'original-turn', runtimeGeneration: 3, terminal: true,
  knownCommandItem: (itemId: string) => itemId === command.id }
const frame = (params: CodexNotificationEnvelope['params'], runtimeGeneration = 3): CodexNotificationEnvelope => ({
  providerVersion: 'codex-cli 0.154.0', schemaIdentity: 'synthetic-recorded-schema', connectionId: 'original-connection',
  runtimeGeneration, arrivalOrdinal: 4, method: 'item/completed', params,
})

async function fixture() {
  const replay = new ActivityProductionReplay(), infrastructure = replay.infrastructure()
  assert.equal(infrastructure.mode, 'replay')
  if (infrastructure.mode !== 'replay') throw new Error('Expected explicit recorded replay.')
  const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined, undefined, 'none', undefined, infrastructure.codex)
  const source = input('/recorded-workspace'); delete source.environment
  const session = await manager.createSession(source)
  const iterator = manager.startTurn(session, { prompt: 'Recorded original child', clientCorrelationId: 'original-A' })[Symbol.asyncIterator]()
  await iterator.next()
  const start = replay.starts[0]!
  replay.commandRunning(session.nativeSessionId, start.nativeTurnId)
  replay.complete(session.nativeSessionId, start.nativeTurnId, '')
  await iterator.return?.()
  const before = await manager.history(session)
  const completions = async () => (await manager.history(session)).events.flatMap(event => {
    const known = knownNativeActivity(event, 'codex')
    return known?.native.sessionId === session.nativeSessionId && known.native.turnId === start.nativeTurnId
      && known.native.itemId === command.id ? [known] : []
  })
  return { replay, manager, source, session, start, before, completions }
}

describe('recorded already-known Codex command completion after parent terminal', () => {
  it('classifies only the exact known command completion without producing a parent terminal', () => {
    assert.equal(normalizeCodexNotification(owner, frame({ threadId: owner.threadId, turnId: owner.turnId, item: command })).kind, 'item')
  })

  it('caches the late original completion for resident reconciliation while preserving empty final text', async () => {
    const f = await fixture()
    try {
      assert.deepEqual(f.before.terminalResult?.output, { text: '' })
      f.replay.commandCompleted(f.session.nativeSessionId, f.start.nativeTurnId)
      f.replay.commandCompleted(f.session.nativeSessionId, f.start.nativeTurnId) // Duplicate evidence is idempotent.
      f.replay.append(f.session.nativeSessionId, f.start.nativeTurnId, 'late answer must stay ignored')
      const after = await f.manager.reconcile(f.session, 'original-A')
      const completed = await f.completions()
      assert.equal(completed.length, 1)
      assert.equal(completed[0]!.change.status, 'completed')
      assert.equal(completed[0]!.change.output, '')
      const completion = after.events.find(event => event.type === 'item.completed' && (event.payload.item as typeof command)?.id === command.id)!
      assert.equal((completion.payload.item as typeof command).exitCode, 0)
      assert.deepEqual(after.terminalResult, f.before.terminalResult)
      assert.equal(after.nativeTurnId, f.start.nativeTurnId)
      assert.equal(after.terminalTurn?.correlationId, 'original-A')
      assert.deepEqual(after.events, [...f.before.events, completion])
      assert.deepEqual((await f.manager.reconcile(f.session, 'original-A')).events, after.events)
      assert.equal(f.replay.starts.length, 1)
      assert.equal(f.replay.responses.length, 0)
      assert.equal(f.replay.calls.some(call => ['thread/resume', 'thread/turns/list'].includes(call.method)), false)
    } finally { await f.manager.dispose() }
  })

  for (const [name, change] of [
    ['unknown item', { item: { ...command, id: 'unknown-command' } }],
    ['wrong turn', { turnId: 'other-turn' }],
    ['wrong session', { threadId: 'other-session' }],
    ['mismatched item fields', { itemId: 'different-item' }],
    ['wrong item type', { item: { ...command, type: 'agentMessage', text: 'late answer', phase: 'final_answer' } }],
    ['still running', { item: { ...command, status: 'inProgress', exitCode: null } }],
  ] as const) it(`denies ${name} as original terminal-child evidence`, async () => {
    const f = await fixture()
    try {
      f.replay.channels.get(f.session.nativeSessionId)!.notify('item/completed', Object.assign({
        threadId: f.session.nativeSessionId, turnId: f.start.nativeTurnId, item: command,
      }, change))
      assert.equal((await f.completions()).length, 0)
      assert.equal((await f.manager.history(f.session)).events.filter(event => event.type === 'item.completed').length,
        f.before.events.filter(event => event.type === 'item.completed').length)
      assert.deepEqual((await f.manager.history(f.session)).terminalResult, f.before.terminalResult)
      assert.equal(f.replay.starts.length, 1)
      assert.equal(f.replay.responses.length, 0)
    } finally { await f.manager.dispose() }
  })

  it('denies stale generation frames in pure normalization', () => {
    assert.equal(normalizeCodexNotification(owner, frame({ threadId: owner.threadId, turnId: owner.turnId, item: command }, 2)).kind, 'ignored')
  })

  it('does not treat a prior generation start as current evidence after a saved-thread resume', async () => {
    const f = await fixture()
    try {
      const old = f.replay.channels.get(f.session.nativeSessionId)!
      old.disconnect(new Error('Recorded channel loss'))
      await f.manager.attachSession(f.session, f.source)
      const current = f.replay.channels.get(f.session.nativeSessionId)!
      assert.notEqual(current, old)
      for (const channel of [old, current]) channel.notify('item/completed', {
        threadId: f.session.nativeSessionId, turnId: f.start.nativeTurnId, item: command,
      })
      assert.equal((await f.completions()).length, 0)
      assert.deepEqual((await f.manager.history(f.session)).terminalResult, f.before.terminalResult)
      assert.equal(f.replay.starts.length, 1)
      assert.equal(f.replay.responses.length, 0)
    } finally { await f.manager.dispose() }
  })
})
