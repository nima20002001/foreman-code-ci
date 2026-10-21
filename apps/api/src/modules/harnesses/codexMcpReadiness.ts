import { codexRequest } from './codexProtocol.js'
import { CodexRpcError, type CodexStdioTransport } from './codexStdioTransport.js'
import { HarnessExecutionError } from './errors.js'
import { waitForCodexCapacity } from './codexCapacity.js'

const startupDelays = [10_000, 20_000, 40_000]

export async function* retryCodexAppMcp(
  transport: Pick<CodexStdioTransport, 'request'>, threadId: string, serverName: string, signal: AbortSignal,
  timers: { schedule: typeof setTimeout; cancelTimer: typeof clearTimeout },
  reload: (signal: AbortSignal) => Promise<void>,
): AsyncGenerator<{ attempt: number; delayMs: number }, void> {
  const deadline = new AbortController()
  const timer = timers.schedule(() => deadline.abort(new HarnessExecutionError('CODEX_APP_MCP_NOT_READY',
    'Foreman Code MCP did not become ready within two minutes. Retry the activation.', true)), 120_000)
  const retrySignal = AbortSignal.any([signal, deadline.signal])
  let reloadFailure: CodexRpcError | undefined
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await requireCodexAppMcp(transport, threadId, serverName, retrySignal)
        return
      } catch (error) {
        retrySignal.throwIfAborted()
        if (!(error instanceof HarnessExecutionError) || error.result.error?.code !== 'CODEX_APP_MCP_NOT_READY') {
          throw error
        }
        const delayMs = startupDelays[attempt - 1]
        if (delayMs === undefined) {
          if (reloadFailure) throw new HarnessExecutionError('CODEX_APP_MCP_NOT_READY', error.message, true,
            { cause: new AggregateError([error, reloadFailure]) })
          throw error
        }
        yield { attempt: attempt + 1, delayMs }
        retrySignal.throwIfAborted()
        try {
          await reload(retrySignal)
          reloadFailure = undefined
        } catch (error) {
          retrySignal.throwIfAborted()
          if (!(error instanceof CodexRpcError)) throw error
          // A failed reload can leave tools usable; the next catalog check decides readiness.
          reloadFailure = error
        }
        await waitForCodexCapacity(delayMs, retrySignal, timers)
        retrySignal.throwIfAborted()
      }
    }
  } finally {
    timers.cancelTimer(timer)
  }
}

/** Read the session's runtime catalog, since configured servers can fail during startup. */
export async function requireCodexAppMcp(
  transport: Pick<CodexStdioTransport, 'request'>, threadId: string, serverName: string, signal: AbortSignal,
): Promise<void> {
  const cursors = new Set<string>()
  let cursor: string | undefined
  try {
    do {
      const page = await codexRequest(transport, 'mcpServerStatus/list', {
        threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}),
      }, signal)
      const server = page.data.find(entry => entry.name === serverName)
      if (server?.runtimeStatus === 'connected' && !server.toolsError && Object.keys(server.tools).length > 0) return
      if (server) break
      cursor = page.nextCursor ?? undefined
      if (cursor && cursors.has(cursor)) break
      if (cursor) cursors.add(cursor)
    } while (cursor)
  } catch (error) {
    signal.throwIfAborted()
    throw new HarnessExecutionError('CODEX_APP_MCP_NOT_READY',
      'Foreman Code MCP readiness could not be verified. Retry the activation.', true, { cause: error })
  }
  throw new HarnessExecutionError('CODEX_APP_MCP_NOT_READY',
    'Foreman Code MCP did not start or exposes no tools in this session. Retry the activation.', true)
}
