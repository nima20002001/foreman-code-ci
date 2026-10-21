import type { ClaudeSdkClient } from '../../src/modules/harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../../src/modules/harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../../src/modules/harnesses/claudeSdk/runner.js'
import { createClaudeNativeSessionManager } from '../../src/modules/harnesses/claudeSdk/sessionManager.js'
import { createClaudeEventNormalizer } from '../../src/modules/harnesses/claudeSdk/normalization.js'
import { claudeNativeEvent } from '../../src/modules/harnesses/claudeSdk/nativeEvents.js'

/** Recorded SDK frames below the real runner and session manager. Each query represents one native process. */
export function operatorClaudeReplay(cwd: string) {
  const transcript: unknown[] = []
  const prompts: string[] = []
  let queries = 0
  let closures = 0
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284',
    getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => transcript,
    forkSession: async () => { throw new Error('This replay does not fork native sessions.') },
    query(input) {
      queries++
      const output = new ClaudeBoundedQueue<unknown>(64)
      const init = { type: 'system', subtype: 'init', session_id: 'recorded-operator-session',
        claude_code_version: '2.1.284', cwd }
      const pumping = (async () => {
        if (input.options.resume) await output.offer(init)
        for await (const message of input.prompt) {
          prompts.push(message.message.content)
          transcript.push({ type: 'user', uuid: message.uuid, session_id: init.session_id, parent_tool_use_id: null })
          await output.offer(init)
          const reply = { type: 'assistant', uuid: `reply:${message.uuid}`, session_id: init.session_id,
            parent_tool_use_id: null, user_message_uuid: message.uuid,
            message: { id: `answer:${message.uuid}`, content: [{ type: 'text', text: 'Recorded reply' }] } }
          transcript.push(reply)
          await output.offer(reply)
          await output.offer({ type: 'result', uuid: `result:${message.uuid}`, session_id: init.session_id,
            user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'Recorded reply' })
        }
      })()
      void pumping.catch(error => output.close(error))
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        close: () => output.close(),
        joinClosed: async () => { await pumping; closures++ },
        initializationResult: async () => ({}), mcpServerStatus: async () => [],
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }), interrupt: async () => undefined,
      }
    },
  }
  const manager = () => createClaudeNativeSessionManager({
    runner: createClaudeSdkRunner({ loadClient: async () => client }),
    scope: { deviceId: 'recorded-host', profilePath: '/recorded/profile', configRevision: '1', cwd },
    sdkOptions: {}, qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true,
      resume: true, fork: false, history: true },
    decodeFactory() {
      const normalizer = createClaudeEventNormalizer({
        owner: { ownerId: 'recorded-owner', attemptId: 'recorded-conversation', generation: 'recorded-query' },
        observedAt: () => new Date().toISOString(),
      })
      return raw => normalizer.ingest(raw).map(event => claudeNativeEvent(event, 0))
    },
  })
  return { manager, prompts, queries: () => queries, closures: () => closures }
}
