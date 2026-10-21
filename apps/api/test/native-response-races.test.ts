import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DurableInteraction } from '@foreman-code/contracts'
import {
  CodexAppServerSessionManager,
  type CodexSessionDependencies,
  type CodexTransport,
} from '../src/modules/harnesses/codexAppServer.js'
import type { CodexStdioTransport, JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import type { Turn } from '../src/modules/harnesses/codexMethodTypes.js'
import { matchingDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { deferred } from './helpers/deferred.js'
import { fixtureProtocol, input, nativeThread } from './fixtures/codex-test-helpers.js'

async function approvalFixture() {
  let receiveRequest!: ConstructorParameters<typeof CodexStdioTransport>[4]
  let notify!: ConstructorParameters<typeof CodexStdioTransport>[5]
  const historyEntered = deferred()
  const releaseHistory = deferred()
  const responseEntered = deferred()
  const releaseResponse = deferred()
  const writes: unknown[] = []
  const turn: Turn = { id: 'native-turn', status: 'inProgress', items: [], itemsView: 'full',
    error: null, startedAt: 1, completedAt: null, durationMs: null }
  const transport: CodexTransport = {
    start: async () => undefined,
    close: async () => undefined,
    isConnected: () => true,
    reject: async () => { throw new Error('Unexpected request rejection') },
    respond: async (_id, _method, value) => {
      writes.push(value)
      responseEntered.resolve()
      await releaseResponse.promise
    },
    request: async (method, params) => {
      if (method === 'config/read') return { config: { mcp_servers: {} } }
      if (method === 'thread/start') return {
        thread: nativeThread({ id: 'native-session', cwd: '/project' }), model: params?.model,
        modelProvider: 'openai', cwd: params?.cwd, serviceTier: null,
        reasoningEffort: (params?.config as JsonObject).model_reasoning_effort,
        approvalPolicy: params?.approvalPolicy, approvalsReviewer: params?.approvalsReviewer,
        sandbox: { type: 'readOnly', networkAccess: false },
      }
      if (method === 'turn/start') return { turn }
      if (method === 'thread/read') {
        historyEntered.resolve()
        await releaseHistory.promise
        return { thread: nativeThread({ id: 'native-session', cwd: '/project', turns: [turn] }) }
      }
      throw new Error(`Unexpected native request: ${method}`)
    },
  }
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay', environment: () => ({}),
    qualify: async binary => ({ binary, identity: 'replay', protocol: fixtureProtocol,
      providerVersion: '0.154.0', schemaManifestSha256: 'replay', stableSchemaGitBlob: 'replay',
      referenceSchemaManifestSha256: 'replay' }),
    assertUnchanged: async () => undefined,
    qualifyModel: async () => undefined,
    runCommand: async (_binary, args) => ({ stdout: args[1] === 'list' ? '[]' : '',
      stderr: args[1] === 'get' ? `Error: No MCP server named '${args[2]}' found.` : '',
      exitCode: args[1] === 'get' ? 1 : 0, exitSignal: null }),
    id: randomUUID, now: () => new Date('2026-10-01T00:00:00Z'),
    schedule: setTimeout, cancelTimer: clearTimeout,
    withDiagnostics: async (_pin, run) => run(dependencies),
    transport: (...args) => {
      receiveRequest = args[4]
      notify = args[5]
      return transport
    },
  }
  const manager = new CodexAppServerSessionManager('/replay-codex', undefined, undefined,
    undefined, 'none', undefined, dependencies)
  const source = input('/project')
  delete source.environment
  const session = await manager.createSession(source)
  const stream = manager.startTurn(session, { prompt: 'run command', clientCorrelationId: 'turn' })[Symbol.asyncIterator]()
  let event = await stream.next()
  while (!event.done && event.value.type !== 'turn.started') event = await stream.next()
  expect(event.done).toBe(false)
  const request = { threadId: session.nativeSessionId, turnId: turn.id, itemId: 'command',
    command: 'printf approved', cwd: '/project', availableDecisions: ['accept', 'decline'] }
  await receiveRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: request })
  const pending = await manager.pending(session)
  if (!pending?.turn.nativeRequestId) throw new Error('Missing native approval')
  const option = pending.responseOptions.find(value => value.semantic === 'approve_once')!
  const resolveRequest = () => notify('serverRequest/resolved', { threadId: session.nativeSessionId, requestId: 7 })
  const completeCommand = () => notify('item/completed', { threadId: session.nativeSessionId,
    turnId: turn.id, item: { id: 'command', type: 'commandExecution', command: request.command,
      cwd: request.cwd, status: 'completed', exitCode: 0 } })
  const interaction: DurableInteraction = {
    id: 'interaction', revision: 1, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    executionId: 'execution', requestingAgentId: 'agent', graphThreadId: 'run', ...session,
    nativeRequestId: pending.turn.nativeRequestId, nativeRequestType: pending.nativeRequestType,
    request: pending.request, responseOptions: pending.responseOptions, approval: { handler: 'user' },
    selectedOptionId: option.optionId, selectedSemantic: option.semantic, nativeResponse: { ...option } as DurableInteraction['nativeResponse'],
    status: 'delivery_pending', deliveryState: 'submitted',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  }
  return { manager, session, pending, option, writes, interaction, historyEntered, releaseHistory,
    responseEntered, releaseResponse, resolveRequest, completeCommand,
    async readSubmitted() {
      let event = await stream.next()
      while (!event.done && event.value.type !== 'interaction.submitted') event = await stream.next()
      expect(event.done).toBe(false)
    },
    async close() {
      releaseHistory.resolve()
      releaseResponse.resolve()
      notify('turn/completed', { threadId: session.nativeSessionId, turn: { ...turn, status: 'completed' } })
      await stream.return?.()
      await manager.shutdown()
    } }
}

describe('native approval response interleavings', () => {
  it('reserves an idle lifecycle callback before reporting response availability', async () => {
    const f = await approvalFixture()
    const sending = f.manager.respond(f.session, f.pending.turn.nativeRequestId!, f.option)
    const outcome = Promise.allSettled([sending])
    try {
      expect(await f.manager.inspectResponseAvailability(f.session, {
        nativeRequestId: f.pending.turn.nativeRequestId!, nativeRequestType: f.pending.nativeRequestType,
        expectedNativeTurnId: f.pending.turn.nativeTurnId!,
      })).toMatchObject({ state: 'recovery_required', reason: 'response_in_flight' })
      expect(await f.manager.pending(f.session)).toBeUndefined()
    } finally {
      await f.close()
      await outcome
    }
  })

  it('proves an ordered submitted command history without a reservation or response digest', async () => {
    const f = await approvalFixture()
    const sending = f.manager.respond(f.session, f.pending.turn.nativeRequestId!, f.option)
    try {
      await f.responseEntered.promise
      f.releaseResponse.resolve()
      await f.readSubmitted()
      f.resolveRequest()
      f.completeCommand()
      await sending
      // Exercise retained-history qualification independently of adapter-produced receipts.
      const history = { ...await f.manager.history(f.session), responseDeliveries: [] }
      const events = history.events.filter(event => event.type !== 'interaction.submitting')
        .map(event => {
          const copy = structuredClone(event)
          if (copy.type === 'interaction.submitted') delete copy.payload.responseDigest
          return copy
        })
      expect(matchingDeliveryEvidence(f.interaction, f.session, { ...history, events })).toMatchObject({
        source: 'provider_history', nativeRequestId: f.pending.turn.nativeRequestId,
        optionId: f.option.optionId, semantic: f.option.semantic,
      })
    } finally { await f.close() }
  })

  it('delivers a response queued behind an in-flight history reconciliation exactly once', async () => {
    const f = await approvalFixture()
    const reading = f.manager.reconcile(f.session, 'turn')
    await f.historyEntered.promise
    const sending = f.manager.respond(f.session, f.pending.turn.nativeRequestId!, f.option)
    const outcome = Promise.allSettled([sending])
    f.releaseHistory.resolve()
    try {
      await reading
      await Promise.race([f.responseEntered.promise, outcome])
      f.releaseResponse.resolve()
      f.resolveRequest()
      expect(await outcome).toEqual([{ status: 'fulfilled', value: undefined }])
      expect(f.writes).toEqual([{ decision: 'accept' }])
      await expect(f.manager.respond(f.session, f.pending.turn.nativeRequestId!, f.option)).rejects.toThrow()
      expect(f.writes).toHaveLength(1)
    } finally { await f.close() }
  })

  it('allows session closure to clear a dispatched response still awaiting native resolution', async () => {
    const f = await approvalFixture()
    const sending = f.manager.respond(f.session, f.pending.turn.nativeRequestId!, f.option)
    const outcome = Promise.allSettled([sending])
    try {
      await f.responseEntered.promise
      f.releaseResponse.resolve()
      await f.readSubmitted()
      await f.manager.close(f.session)
      expect(await outcome).toMatchObject([{ status: 'rejected', reason: {
        result: { error: { code: 'NATIVE_RESPONSE_CLEARED' } },
      } }])
      expect(f.writes).toEqual([{ decision: 'accept' }])
    } finally { await f.close() }
  })

  it.each(['before-write-callback', 'after-write-callback'] as const)(
    'proves command delivery when native resolution arrives %s', async ordering => {
      const f = await approvalFixture()
      const sending = f.manager.respond(f.session, f.pending.turn.nativeRequestId!, f.option)
      try {
        await f.responseEntered.promise
        if (ordering === 'after-write-callback') {
          f.releaseResponse.resolve()
          await f.readSubmitted()
          const history = await f.manager.history(f.session)
          expect(history.events.some(event => event.type === 'interaction.submitted')).toBe(true)
        }
        f.resolveRequest()
        f.completeCommand()
        const beforeCallback = await f.manager.history(f.session)
        if (ordering === 'before-write-callback') {
          expect(beforeCallback.events.some(event => event.type === 'interaction.submitted')).toBe(false)
          expect(matchingDeliveryEvidence(f.interaction, f.session, beforeCallback)).toBeUndefined()
        }
        f.releaseResponse.resolve()
        await sending
        // Exercise retained-history qualification independently of adapter-produced receipts.
        const history = { ...await f.manager.history(f.session), responseDeliveries: [] }
        const types = history.events.map(event => event.type)
        expect(types.indexOf('interaction.resolved') < types.indexOf('interaction.submitted'))
          .toBe(ordering === 'before-write-callback')
        expect(matchingDeliveryEvidence(f.interaction, f.session, history)).toMatchObject({
          source: 'provider_history', nativeRequestId: f.pending.turn.nativeRequestId,
          optionId: f.option.optionId, semantic: f.option.semantic,
        })
        for (const type of ['interaction.pending', 'interaction.submitted',
          'interaction.resolved', 'item.completed']) {
          expect(matchingDeliveryEvidence(f.interaction, f.session, {
            ...history, events: history.events.filter(event => event.type !== type),
          })).toBeUndefined()
        }
        const withoutReservation = matchingDeliveryEvidence(f.interaction, f.session, {
          ...history, events: history.events.filter(event => event.type !== 'interaction.submitting'),
        })
        if (ordering === 'before-write-callback') expect(withoutReservation).toBeUndefined()
        else expect(withoutReservation).toMatchObject({ optionId: f.option.optionId, semantic: f.option.semantic })
        expect(matchingDeliveryEvidence({ ...f.interaction, selectedOptionId: 'other-choice' },
          f.session, history)).toBeUndefined()
        for (const payload of [{ optionId: 'other-choice' }, { semantic: 'deny' }, { responseDigest: 'other-response' }]) {
          expect(matchingDeliveryEvidence(f.interaction, f.session, {
            ...history, events: history.events.map(event => event.type === 'interaction.submitted'
              ? { ...event, payload: { ...event.payload, ...payload } } : event),
          })).toBeUndefined()
        }
      } finally { await f.close() }
    })
})
