import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import {
  PendingNativeInteractionSchema,
  type ApprovalResponseOption, type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference, type PendingNativeInteraction,
} from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../../src/modules/harnesses/port.js'
import { deferred } from './deferred.js'

export async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await setImmediate()
  }
  assert.fail('The expected chat state did not become observable.')
}

export function approval(session: NativeSessionReference, nativeTurnId: string, nativeRequestId: string): PendingNativeInteraction {
  return PendingNativeInteractionSchema.parse({ session, turn: { nativeTurnId, nativeRequestId },
    nativeRequestType: 'item/commandExecution/requestApproval', request: { command: `fixture-${nativeRequestId}` },
    responseOptions: [{ optionId: 'approve-once', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }] })
}

/** Deterministic native-port substitute. It does not launch a provider or prove provider behavior. */
export class AgentChatF5Native implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  readonly session: NativeSessionReference = { harness: 'codex', providerVersion: 'f5-fixture', nativeSessionId: 'native-f5' }
  readonly started = deferred()
  readonly responses: string[] = []
  readonly prompts: string[] = []
  readonly pendingRequests: PendingNativeInteraction[] = []
  pendingCalls = 0
  beforeResponse: (() => Promise<void>) | undefined
  beforePendingReturn: (() => Promise<void>) | undefined
  nativeTurnId = 'turn-f5'
  private turnNumber = 0
  private historyValue: NativeHistory = { events: [], pendingInteractions: [] }
  private readonly events: NativeHarnessEvent[] = []
  private wake: (() => void) | undefined
  private result: ExecutionResult | undefined

  async capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> {
    return { provider: 'codex', providerVersion: 'f5-fixture', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false,
      mcpDetection: false, supportedInteractionKinds: [] }
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('No MCP process in this fixture.') }
  async createSession() { return this.session }
  async attachSession(session: NativeSessionReference) { return session }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.prompts.push(input.prompt)
    this.nativeTurnId = `turn-f5-${++this.turnNumber}`
    this.result = undefined
    this.historyValue = { correlationId: input.clientCorrelationId, nativeTurnId: this.nativeTurnId, events: [], pendingInteractions: [] }
    await input.onSubmitted?.(this.nativeTurnId)
    this.started.resolve()
    const wake = () => this.wake?.()
    signal?.addEventListener('abort', wake, { once: true })
    try {
      while (!this.result) {
        signal?.throwIfAborted()
        const event = this.events.shift()
        if (event) yield event
        else await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', wake)
      this.wake = undefined
    }
  }
  offer(nativeRequestId: string) {
    this.pendingRequests.push(approval(this.session, this.nativeTurnId, nativeRequestId))
    this.events.push({ sequence: this.pendingRequests.length, type: 'interaction.pending', occurredAt: new Date().toISOString(), payload: {} })
    this.wake?.()
  }
  async pending() {
    this.pendingCalls++
    const snapshot = structuredClone(this.pendingRequests[0])
    await this.beforePendingReturn?.()
    return snapshot
  }
  async respond(_session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption) {
    this.responses.push(nativeRequestId)
    await this.beforeResponse?.()
    const index = this.pendingRequests.findIndex((item) => item.turn.nativeRequestId === nativeRequestId)
    assert.notEqual(index, -1, 'A stale response reached the native port.')
    assert.deepEqual(option, this.pendingRequests[index]!.responseOptions[0])
    this.pendingRequests.splice(index, 1)
  }
  finish(result: ExecutionResult = { outcome: 'succeeded' }) {
    this.result = result
    this.historyValue.terminalResult = result
    this.wake?.()
  }
  async cancel() { this.finish({ outcome: 'canceled' }); return true }
  async history() { return { ...this.historyValue, pendingInteractions: structuredClone(this.pendingRequests) } }
  async reconcile() { return this.history() }
  async close() { this.finish({ outcome: 'canceled' }) }
}
