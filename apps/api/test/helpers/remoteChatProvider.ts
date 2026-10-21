import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeHarnessSessionManager } from '../../src/modules/harnesses/port.js'
import type { CodexChatFiles } from '../../src/modules/harnesses/codexFiles/runtime.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import type { ClaudeSdkClient } from '../../src/modules/harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../../src/modules/harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../../src/modules/harnesses/claudeSdk/runner.js'
import { allocateClaudeNativeHarness } from '../../src/modules/harnesses/claudeSdk/composition.js'
import { ActivityProductionReplay } from './activityProductionReplay.js'
import { deferred, type Deferred } from './deferred.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'

async function emitClaudeReply(input: {
  frames: ClaudeBoundedQueue<unknown>; sessionId: string; promptUuid: string;
  gates: readonly (Deferred<void> | undefined)[];
}) {
  const transcript: Record<string, unknown>[] = []
  let parentUuid = input.promptUuid
  for (const [round, gate] of input.gates.entries()) {
    const messageId = randomUUID()
    const common = { session_id: input.sessionId, parent_tool_use_id: null }
    const echo = round === 0 ? { user_message_uuid: input.promptUuid } : {}
    const text = input.gates.length === 1 ? 'Remote streamed answer' : `Remote tool round ${round + 1}`
    const stream = (event: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
      input.frames.offer({ ...common, type: 'stream_event', uuid: randomUUID(), event, ...fields })
    await stream({ type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } }, echo)
    await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    await stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    await gate?.promise
    const content: Record<string, unknown>[] = [{ type: 'text', text }]
    const toolId = randomUUID()
    if (round < input.gates.length - 1) {
      const tool = { type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/recorded/file' } }
      await stream({ type: 'content_block_start', index: 1, content_block: tool })
      content.push(tool)
    }
    const assistant = { ...common, type: 'assistant', uuid: randomUUID(), parentUuid, ...echo,
      message: { id: messageId, role: 'assistant', content } }
    await input.frames.offer(assistant)
    transcript.push(assistant)
    parentUuid = assistant.uuid
    await stream({ type: 'message_stop' })
    if (round < input.gates.length - 1) {
      const result = { ...common, type: 'user', uuid: randomUUID(), parentUuid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Recorded tool output' }] } }
      await input.frames.offer(result)
      transcript.push(result)
      parentUuid = result.uuid
    }
  }
  return transcript
}

/** Only provider I/O is recorded. Both native adapters and the remote conversation stack are real. */
export async function remoteChatProvider(harness: 'codex' | 'claude', directory: string, options: {
  codexFiles?: CodexChatFiles
  codexInput?(input: unknown): Promise<void>
  claudeMessage?(sessionId: string, messageId: string): Promise<void>
} = {}) {
  const modes: string[] = []
  const prompts: unknown[] = []
  const calls: string[] = []
  const models = ['test-model', 'changed-model', 'secondary-model', DEFAULT_HARNESS_DEFAULTS.codex.model]
  let compactions = 0
  let reply: Deferred<void> | undefined
  let claudeToolRounds: Deferred<void>[] | undefined
  const claudeTranscript: Record<string, unknown>[] = []
  let holdCompactionNotifications = false
  const compactionNotifications: Array<() => void> = []
  let createNativeManager: () => NativeHarnessSessionManager
  if (harness === 'codex') {
    const replay = new ActivityProductionReplay(`remote-chat-${randomUUID()}`, models)
    const infrastructure = replay.infrastructure()
    if (infrastructure.mode !== 'replay') throw new Error('Recorded provider infrastructure required')
    const dependencies = { ...infrastructure.codex,
      transport: (...args: Parameters<typeof infrastructure.codex.transport>) => {
        const transport = infrastructure.codex.transport(...args)
        return { ...transport, request: async (...requestArgs: Parameters<typeof transport.request>) => {
          const [method, params = {}] = requestArgs
          calls.push(method)
          if (method === 'turn/steer') {
            const thread = replay.threads.get(String(params.threadId))
            const turn = thread?.turns.find(value => value.id === params.expectedTurnId)
            if (!turn || turn.status !== 'inProgress' || !Array.isArray(params.input)) {
              throw new Error('The recorded steer must address its active native turn')
            }
            turn.items.push({ id: randomUUID(), type: 'userMessage',
              clientId: params.clientUserMessageId ?? null, content: params.input })
            return { turnId: turn.id }
          }
          if (method === 'thread/compact/start') {
            compactions++
            const thread = replay.threads.get(String(params.threadId))!
            const turn = { id: `compact-${compactions}`, status: 'completed', error: null,
              startedAt: 1, completedAt: 2, durationMs: 1,
              items: [{ id: `boundary-${compactions}`, type: 'contextCompaction' }] }
            thread.turns.push(turn)
            const channel = replay.channels.get(thread.id)!
            const notify = () => {
              channel.notify('turn/started', { threadId: thread.id, turn: { ...turn, status: 'inProgress' } })
              channel.notify('turn/completed', { threadId: thread.id, turn })
            }
            if (holdCompactionNotifications) compactionNotifications.push(notify)
            else setImmediate(notify)
            return {}
          }
          const result = await transport.request(...requestArgs)
          if (method === 'turn/start') {
            prompts.push(params.input)
            await options.codexInput?.(params.input)
            const mode = params.collaborationMode as { mode?: string } | undefined
            modes.push(mode?.mode ?? 'default')
            const turn = replay.starts.at(-1)!
            setImmediate(async () => {
              const itemId = randomUUID()
              replay.append(turn.sessionId, turn.nativeTurnId, 'Remote streamed answer', itemId)
              await reply?.promise
              replay.complete(turn.sessionId, turn.nativeTurnId, 'Remote streamed answer', itemId)
            })
          }
          return result
        } }
      } }
    createNativeManager = () => new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'none', options.codexFiles, dependencies)
  } else {
    const nativeId = randomUUID()
    const profilePath = join(directory, 'claude-profile')
    const transcriptDirectory = join(profilePath, 'projects', 'recorded')
    await mkdir(transcriptDirectory, { recursive: true })
    const transcriptPath = join(transcriptDirectory, `${nativeId}.jsonl`)
    await writeFile(transcriptPath, '')
    const sdk: ClaudeSdkClient = {
      sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
      getSessionMessages: async (sessionId, { offset = 0, limit = 256 }) => sessionId === nativeId
        ? structuredClone(claudeTranscript.slice(offset, offset + limit)) : [],
      forkSession: async () => { throw new Error('This chat fixture does not fork') },
      query(input) {
        const frames = new ClaudeBoundedQueue<unknown>(32)
        const consume = (async () => {
          for await (const message of input.prompt) {
            prompts.push(message.message.content)
            const parentUuid = claudeTranscript.at(-1)?.uuid
            claudeTranscript.push({ ...structuredClone(message), session_id: nativeId, parent_tool_use_id: null,
              ...(typeof parentUuid === 'string' ? { parentUuid } : {}) })
            await frames.offer({ type: 'system', subtype: 'init', session_id: nativeId,
              claude_code_version: '2.1.284', cwd: directory, slash_commands: ['compact'] })
            if (message.message.content === '/compact') {
              compactions++
              await appendFile(transcriptPath, JSON.stringify({ type: 'system', subtype: 'compact_boundary',
                cwd: directory, sessionId: nativeId, uuid: randomUUID(),
                compactMetadata: { trigger: 'manual', preTokens: 100 }, timestamp: new Date().toISOString() }) + '\n')
              await frames.offer({ type: 'system', subtype: 'compact_boundary', session_id: nativeId,
                uuid: randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 100 } })
            } else {
              claudeTranscript.push(...await emitClaudeReply({ frames, sessionId: nativeId,
                promptUuid: message.uuid, gates: claudeToolRounds ?? [reply] }))
              await options.claudeMessage?.(nativeId, message.uuid)
            }
            await frames.offer({ type: 'result', session_id: nativeId, uuid: randomUUID(),
              user_message_uuid: message.uuid, subtype: 'success', is_error: false,
              ...(message.message.content === '/compact' ? { local_command: 'compact' } : {}),
              result: 'Remote streamed answer' })
          }
        })()
        void consume.catch(error => frames.close(error))
        return {
          [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
          initializationResult: async () => ({ models: [], account: {} }),
          setPermissionMode: async mode => { modes.push(mode) },
          interrupt: async () => ({}), close: () => frames.close(),
          joinClosed: async () => { await consume },
        }
      },
    }
    createNativeManager = () => allocateClaudeNativeHarness({ harness: 'claude', role: 'agent-chat', appMcpAccess: 'none',
      workingDirectory: directory, ownerAgentId: 'recorded-agent',
      ownerForStart: start => ({ ownerId: start.kind === 'agent-chat' ? start.conversationId : 'recorded-owner',
        attemptId: start.correlationId ?? 'recorded-request', generation: 'recorded-query' }),
      runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'recorded-device', profilePath, configRevision: 'recorded', cwd: directory },
      sdkOptions: { includePartialMessages: true }, qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284',
        basicTurns: true, resume: true, fork: false, history: true } }).manager
  }
  let loseCreationResponse = false
  const observeCreation = (native: NativeHarnessSessionManager) => {
    const createSession = native.createSession.bind(native)
    native.createSession = async (...args) => {
      const session = await createSession(...args)
      if (loseCreationResponse) {
        loseCreationResponse = false
        throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'The recorded native creation response was lost.')
      }
      return session
    }
    return native
  }
  let manager = observeCreation(createNativeManager())
  return { get manager() { return manager }, models, modes, prompts, calls, get compactions() { return compactions },
    createManager() { manager = observeCreation(createNativeManager()); return manager },
    restartManager() { manager = observeCreation(createNativeManager()); return manager },
    loseNextCreationResponse() { loseCreationResponse = true },
    holdCompactionNotifications() { holdCompactionNotifications = true },
    releaseCompactionNotifications() {
      holdCompactionNotifications = false
      for (const notify of compactionNotifications.splice(0)) notify()
    },
    holdReply() { reply = deferred() },
    holdClaudeToolRounds() { claudeToolRounds = Array.from({ length: 3 }, () => deferred()) },
    releaseClaudeToolRound(round: number) { claudeToolRounds?.[round]?.resolve() },
    get persistedClaudeReplies() { return claudeTranscript.filter(frame => frame.type === 'assistant').length },
    releaseReply() {
      reply?.resolve()
      reply = undefined
      for (const gate of claudeToolRounds ?? []) gate.resolve()
      claudeToolRounds = undefined
    },
  }
}
