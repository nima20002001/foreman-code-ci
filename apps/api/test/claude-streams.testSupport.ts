import { OperatorConfigurationVersionSchema, type NativeHarnessEvent } from '@foreman-code/contracts'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import { ClaudeInteractionBridge, type ClaudeCallbackIdentity } from '../src/modules/harnesses/claudeSdk/interactions.js'
import { createClaudeEventNormalizer } from '../src/modules/harnesses/claudeSdk/normalization.js'
import { claudeNativeEvent } from '../src/modules/harnesses/claudeSdk/nativeEvents.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { createClaudeSdkCallbacks } from '../src/modules/harnesses/claudeSdk/sdkCallbacks.js'
import { createClaudeNativeSessionManager, type ClaudeMessageSubmission } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import { memoryClaudeCallbackJournal } from './support/claudeCallbackJournal.js'

const scope = { deviceId: 'device', profilePath: '/profile', configRevision: 'revision', cwd: '/work' }
const configuration: ClaudeHarnessConfiguration = { harness: 'claude', model: 'fixture', authMode: 'subscription',
  configDirectory: '/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'],
  permissionRules: [{ tool: 'Read', effect: 'ask' }], instructions: '', mcpServers: {} }
export const start: NativeSessionStart = { kind: 'operator', correlationId: 'owner',
  configuration: OperatorConfigurationVersionSchema.parse({ id: 'configuration', operatorId: 'operator', version: 1,
    harness: configuration, contentHash: `sha256:${'0'.repeat(64)}`, createdAt: '2026-10-04T00:00:00.000Z' }),
  workingDirectory: '/work' }
export const saved = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }

export function createStreamFixture(options: { receiptCapacity?: number; outputCapacity?: number;
  resumeFailures?: number; workingDirectory?: string;
  validate?(identity: ClaudeCallbackIdentity): Promise<void> } = {}) {
  const queries: { frames: ClaudeBoundedQueue<unknown>; messages: AsyncIterator<ClaudeSdkUserMessage>;
    options: Readonly<Record<string, unknown>>; reads: number; closed: boolean }[] = []
  let resumeFailures = options.resumeFailures ?? 0
  let submitted: ClaudeMessageSubmission | undefined
  const bridge: ClaudeInteractionBridge = new ClaudeInteractionBridge(configuration, {
    callbackJournal: memoryClaudeCallbackJournal(),
    async validate(identity) {
      if (options.validate) return options.validate(identity)
      if (!submitted || identity.nativeMessageId !== submitted.nativeMessageId
        || identity.clientCorrelationId !== submitted.clientCorrelationId) throw new Error('Unpersisted message')
    },
    request: identity => bridge.waitForResponse(identity),
    validateResponse: async () => undefined,
  })
  const callbacks = createClaudeSdkCallbacks({ manager: () => manager, bridge })
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284',
    query(input) {
      if (input.options.resume && queries.length && resumeFailures > 0) {
        resumeFailures--
        throw new Error('Resume unavailable')
      }
      const query = { frames: new ClaudeBoundedQueue<unknown>(4), messages: input.prompt[Symbol.asyncIterator](),
        options: input.options, reads: 0, closed: false }
      queries.push(query)
      return {
        [Symbol.asyncIterator]() {
          const iterator = query.frames[Symbol.asyncIterator]()
          return { async next() { const result = await iterator.next(); query.reads++; return result } }
        },
        interrupt: async () => undefined,
        initializationResult: async () => ({}),
        close() { query.closed = true; query.frames.close(undefined, true) },
      }
    },
    getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [],
    forkSession: async () => ({ sessionId: 'unused' }),
  }
  const runner = createClaudeSdkRunner({ loadClient: async () => client, ...options })
  const manager = createClaudeNativeSessionManager({ runner,
    scope: { ...scope, cwd: options.workingDirectory ?? scope.cwd }, sdkOptions: callbacks,
    qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true,
      resume: true, fork: true, history: true, interactions: true },
    cancelPendingRequests: () => bridge.close(),
    pendingInteractions: session => bridge.pendingInteractions(session),
    interactionPort: { pending: async session => bridge.pendingInteractions(session)[0],
      respond: async (...args) => { await bridge.respond(...args) } },
    decodeFactory: () => {
      const normalizer = createClaudeEventNormalizer({ owner: { ownerId: 'owner', attemptId: 'attempt', generation: 'generation' },
        observedAt: () => '2026-10-04T00:00:00.000Z' })
      return raw => normalizer.ingest(raw).map(event => claudeNativeEvent(event, 0))
    },
  })
  bridge.subscribePending(notification => manager.notifyPendingChanged(notification))
  const onMessageSubmitted = async (identity: ClaudeMessageSubmission) => { submitted = identity }
  const frame = (value: Record<string, unknown>, uuid: string) => ({ session_id: saved.nativeSessionId,
    user_message_uuid: uuid, ...value })
  async function complete(message: ClaudeSdkUserMessage, correlationId: string) {
    const query = queries.at(-1)!
    await query.frames.offer(frame({ type: 'assistant', uuid: `assistant-${correlationId}`,
      message: { id: `message-${correlationId}`, content: [{ type: 'text', text: correlationId }] } }, message.uuid))
    await query.frames.offer(frame({ type: 'result', uuid: `result-${correlationId}`,
      subtype: 'success', is_error: false, result: correlationId }, message.uuid))
  }
  return { manager, runner, bridge, callbacks, queries, frame, complete, onMessageSubmitted }
}

export async function drainEvents(input: AsyncIterable<NativeHarnessEvent>) {
  const events: NativeHarnessEvent[] = []
  for await (const event of input) events.push(event)
  return events
}
