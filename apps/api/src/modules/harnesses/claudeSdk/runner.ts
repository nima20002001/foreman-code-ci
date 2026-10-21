import { ClaudeInputNotDeliveredError } from './port.js'
import { saveClaudeCompactionResult, claudeCompactionResultMatches } from './compactionResults.js'
import { ClaudeBoundedQueue } from './queue.js'
import { isDeepStrictEqual } from 'node:util'
import type {
  ClaudeNativeObservation, ClaudeSdkClient, ClaudeSdkOpenInput,
  ClaudeSdkOutput, ClaudeSdkQuery, ClaudeSdkRunner, ClaudeSdkSession, ClaudeSdkUserMessage,
} from './port.js'
import { ignoreError } from '../../diagnostics/ignoredError.js'
import { assertClaudeSessionScope, claudeSessionHistory, readClaudeResponseOwner } from './runnerHistory.js'
import { claudeQueryControls } from './queryControls.js'

export { assertClaudeSessionScope } from './runnerHistory.js'

function observationOf(raw: unknown): ClaudeNativeObservation | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const frame = raw as Record<string, unknown>
  if (typeof frame.session_id !== 'string' || !frame.session_id) return undefined
  if (frame.parent_tool_use_id != null) return undefined
  if (!['assistant', 'stream_event', 'result'].includes(String(frame.type))) return undefined
  const uuids = Array.isArray(frame.user_message_uuids)
    ? frame.user_message_uuids.filter((value): value is string => typeof value === 'string') : []
  if (typeof frame.user_message_uuid === 'string' && !uuids.includes(frame.user_message_uuid)) uuids.push(frame.user_message_uuid)
  if (!uuids.length) return undefined
  return {
    nativeSessionId: frame.session_id, promptUuids: uuids,
    kind: frame.type === 'result' ? 'result' : 'reply',
    ...(typeof frame.uuid === 'string' ? { providerMessageId: frame.uuid } : {}),
  }
}

function responseObservations(continuation: (frame: Record<string, unknown>) => Promise<readonly string[] | undefined>) {
  const owners = new Map<string, readonly string[]>()
  const finished = new Set<string>()
  let response: readonly string[] | undefined
  let stream: readonly string[] | undefined
  let streamMessageId: string | undefined
  return async (raw: unknown): Promise<ClaudeNativeObservation | undefined> => {
    if (!raw || typeof raw !== 'object') return undefined
    const frame = raw as Record<string, unknown>
    if (typeof frame.session_id !== 'string' || !frame.session_id || frame.parent_tool_use_id != null) return undefined
    if (!['assistant', 'stream_event', 'result'].includes(String(frame.type))) return undefined
    const message = frame.message as { id?: unknown } | undefined
    const event = frame.event as { type?: unknown; message?: { id?: unknown } } | undefined
    const messageId = message?.id ?? event?.message?.id
    const ids: string[] = []
    if (typeof frame.uuid === 'string' && (frame.type !== 'stream_event' || event?.type === 'message_start')) {
      ids.push(`frame:${frame.uuid}`)
    }
    if (typeof messageId === 'string') ids.push(`message:${messageId}`)
    if (frame.type === 'stream_event' && event?.type === 'message_start') {
      streamMessageId = typeof messageId === 'string' ? messageId : undefined
    }
    const echo = observationOf(raw)
    if (echo && frame.type === 'stream_event' && streamMessageId && !ids.includes(`message:${streamMessageId}`)) {
      ids.push(`message:${streamMessageId}`)
    }
    const known = ids.map(id => owners.get(id)).find(owner => owner !== undefined)
    if (echo && known && !isDeepStrictEqual(echo.promptUuids, known)) {
      throw new Error('Claude response identity was reused for another input')
    }
    // Snapshots need ancestry; live message starts can continue an echoed response until its result.
    let promptUuids = echo?.promptUuids ?? (frame.type === 'result' ? undefined : known)
    if (!promptUuids && frame.type !== 'result') {
      promptUuids = frame.type === 'stream_event' && event?.type !== 'message_start'
        ? stream : await continuation(frame)
      if (!promptUuids && frame.type === 'stream_event' && event?.type === 'message_start') promptUuids = response
    }
    if (echo?.kind === 'reply' && !known && !echo.promptUuids.some(uuid => finished.has(uuid))) {
      response = echo.promptUuids
      if (frame.type === 'stream_event') stream = echo.promptUuids
    }
    if (frame.type === 'stream_event' && event?.type === 'message_start') stream = promptUuids
    if (promptUuids) {
      for (const id of ids) {
        const previous = owners.get(id)
        if (previous && !isDeepStrictEqual(previous, promptUuids)) {
          throw new Error('Claude response identity was reused for another input')
        }
        owners.set(id, promptUuids)
      }
    }
    if (frame.type === 'result') {
      for (const uuid of promptUuids ?? []) finished.add(uuid)
      if (!promptUuids || isDeepStrictEqual(promptUuids, response)) {
        response = undefined
        stream = undefined
        streamMessageId = undefined
      }
    }
    if (!promptUuids) return undefined
    return { nativeSessionId: frame.session_id, promptUuids, kind: frame.type === 'result' ? 'result' : 'reply',
      ...(typeof frame.uuid === 'string' ? { providerMessageId: frame.uuid } : {}) }
  }
}

/** Aborting local consumption settles next() even when an SDK generator ignores return(). */
function nextOwned(iterator: AsyncIterator<unknown>, signal: AbortSignal): Promise<IteratorResult<unknown>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => iterator.next()).then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(error) },
    )
  })
}

export function createClaudeSdkRunner(input: {
  loadClient(): Promise<ClaudeSdkClient>
  inputCapacity?: number
  outputCapacity?: number
  receiptCapacity?: number
}): ClaudeSdkRunner {
  const sessions = new Set<ClaudeSdkSession>()
  const openings = new Set<Promise<ClaudeSdkSession>>()
  let disposed = false
  let queryDispatched = false
  const runner: ClaudeSdkRunner = {
    requiresRuntimeClosure: () => queryDispatched,
    open(options) {
      if (disposed) return Promise.reject(new Error('Claude runner disposed'))
      const opening = openSession(options)
      openings.add(opening)
      void opening.then(() => openings.delete(opening), () => openings.delete(opening))
      return opening
    },
    ...claudeSessionHistory({ loadClient: () => input.loadClient(), isDisposed: () => disposed }),
    async dispose() {
      disposed = true
      const result = await Promise.allSettled([...sessions].map((session) => session.close()))
      await Promise.allSettled([...openings])
      const errors = result.flatMap((entry) => entry.status === 'rejected' ? [entry.reason as unknown] : [])
      if (errors.length) throw new AggregateError(errors, 'Claude runner cleanup failed')
    },
  }
  async function openSession(options: ClaudeSdkOpenInput): Promise<ClaudeSdkSession> {
    options.signal?.throwIfAborted()
    if ('continue' in options.options || 'resume' in options.options || 'forkSession' in options.options || 'sessionId' in options.options) {
      throw new Error('Claude session selection must use the exact runner identity port')
    }
    if ((typeof options.options.canUseTool === 'function' || options.options.hooks && Object.keys(options.options.hooks as object).length > 0) && !options.cancelPendingRequests) {
      throw new Error('Claude process-local callbacks require an explicit pending-request cleanup owner')
    }
    if (options.resume) assertClaudeSessionScope(options.resume, options.scope)
    const abort = new AbortController()
    const inputQueue = new ClaudeBoundedQueue<ClaudeSdkUserMessage>(input.inputCapacity ?? 8)
    const outputQueue = new ClaudeBoundedQueue<ClaudeSdkOutput>(input.outputCapacity ?? 256)
    const receipts = new Map<string, ClaudeNativeObservation[]>()
    const offered = new Set<string>()
    let client: ClaudeSdkClient | undefined
    const observeResponse = responseObservations(frame => readClaudeResponseOwner({
      frame, client: client!, scope: options.scope, offered, signal: abort.signal,
    }))
    let compact: { promptUuid: string; boundary: boolean } | undefined
    let nativeSessionId: string | undefined
    let query: ClaudeSdkQuery | undefined
    let queryOpening: Promise<ClaudeSdkQuery> | undefined
    let pump: Promise<void> | undefined
    let closing: Promise<void> | undefined
    let closeFailure: unknown
    let stopped = false
    const stop = () => {
      if (stopped) return
      const errors: unknown[] = []
      try { options.cancelPendingRequests?.() } catch (error) { errors.push(error) }
      inputQueue.close(undefined, true)
      abort.abort(new Error('Claude session closed'))
      try { query?.close() } catch (error) { errors.push(error) }
      outputQueue.close()
      if (errors.length) closeFailure = new AggregateError(errors, 'Claude SDK close failed')
      else { stopped = true; closeFailure = undefined }
    }
    const externalAbort = () => {
      abort.abort(options.signal?.reason)
      void session.close().catch(ignoreError('harness', 'session.close', { module: 'harnesses/claudeSdk/runner' }))
    }
    const session: ClaudeSdkSession = {
      output: outputQueue,
      get nativeSessionId() { return nativeSessionId },
      assertInputCapacity() {
        if (offered.size >= (input.receiptCapacity ?? 256)) {
          throw new ClaudeInputNotDeliveredError('Claude receipt window exhausted; resume the completed session before offering input.')
        }
      },
      async offer(message, signal) {
        signal?.throwIfAborted()
        abort.signal.throwIfAborted()
        if (!message.promptUuid || offered.has(message.promptUuid)) throw new Error('Claude prompt identity missing or already offered; never replay uncertain input')
        session.assertInputCapacity()
        offered.add(message.promptUuid)
        if (message.content === '/compact') compact = { promptUuid: message.promptUuid, boundary: false }
        await inputQueue.offer({ type: 'user', message: { role: 'user', content: message.content }, parent_tool_use_id: null, uuid: message.promptUuid }, signal)
        abort.signal.throwIfAborted()
        return { state: 'queue-offered', promptUuid: message.promptUuid }
      },
      ...claudeQueryControls(() => query, abort.signal),
      reconcile(promptUuid) { return [...(receipts.get(promptUuid) ?? [])] },
      close() {
        if (closing) return closing
        closing = (async () => {
          stop()
          if (!query && queryOpening) {
            const [opened] = await Promise.allSettled([queryOpening])
            if (opened?.status === 'fulfilled') {
              query = opened.value
              query.close()
            }
          }
          await pump
          await query?.joinClosed?.()
          options.signal?.removeEventListener('abort', externalAbort)
          if (closeFailure !== undefined) throw closeFailure
          sessions.delete(session)
        })()
        // Failed cleanup remains owned and retryable; no process-closure receipt is fabricated.
        void closing.catch(() => { closing = undefined })
        return closing
      },
      async closeForRestart() { throw new Error('Claude native restart detachment is unqualified; query.close terminates native work') },
    }
    sessions.add(session)
    options.signal?.addEventListener('abort', externalAbort, { once: true })
    try {
      client = await input.loadClient()
      abort.signal.throwIfAborted()
      if (disposed) throw new Error('Claude runner disposed during startup')
      if (options.resume) {
        const info = await client.getSessionInfo(options.resume.nativeSessionId, { dir: options.scope.cwd })
        abort.signal.throwIfAborted()
        if (!info || info.sessionId !== options.resume.nativeSessionId) throw new Error('Exact Claude session history is unavailable')
      }
      queryOpening = Promise.resolve(client.query({ prompt: inputQueue, scope: options.scope, options: {
        ...options.options, cwd: options.scope.cwd, abortController: abort,
        env: { ...(options.options.env as Record<string, string> | undefined),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}), CLAUDE_CONFIG_DIR: options.scope.profilePath },
        ...(options.resume ? { resume: options.resume.nativeSessionId } : {}),
      } }))
      query = await queryOpening
      queryDispatched = true
      abort.signal.throwIfAborted()
      if (disposed) throw new Error('Claude runner disposed during query startup')
      // The Query itself owns close(), unlike a wrapping async generator's blocked return().
      if (!query.getContextUsage) delete session.getContextUsage
      if (!query.setPermissionMode) delete session.setPermissionMode
      const iterator = query[Symbol.asyncIterator]()
      pump = (async () => {
        try {
          while (!abort.signal.aborted) {
            const next = await nextOwned(iterator, abort.signal)
            if (next.done) break
            const raw = next.value
            const frame = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined
            if (typeof frame?.session_id === 'string') {
              if (nativeSessionId && nativeSessionId !== frame.session_id) throw new Error('Claude native session identity changed')
              if (options.resume && options.resume.nativeSessionId !== frame.session_id) throw new Error('Claude resumed a different native session')
              nativeSessionId = frame.session_id
            }
            if (compact && frame?.type === 'system' && frame.subtype === 'compact_boundary'
              && frame.session_id === nativeSessionId
              && (frame.compact_metadata as { trigger?: string } | undefined)?.trigger === 'manual') compact.boundary = true
            if (compact && frame && nativeSessionId && claudeCompactionResultMatches(frame, nativeSessionId, compact.promptUuid)) {
              await saveClaudeCompactionResult({ ...options.scope, nativeSessionId }, compact.promptUuid,
                frame.is_error === true ? 'failed' : compact.boundary ? 'completed' : 'no-op')
              compact = undefined
            }
            const observation = await observeResponse(raw)
            if (observation) {
              const ownedUuids = observation.promptUuids.filter((uuid) => offered.has(uuid))
              if (ownedUuids.length) {
                const owned = { ...observation, promptUuids: ownedUuids }
                await options.onObservation?.(owned)
                for (const uuid of ownedUuids) {
                  const prior = receipts.get(uuid) ?? []
                  // Keep first acceptance and latest terminal, not every text delta.
                  if (!prior.length || owned.kind === 'result') receipts.set(uuid, [...prior.slice(0, 1), owned])
                }
              }
            }
            await outputQueue.offer({ raw, ...(observation ? { observation } : {}) })
          }
          outputQueue.close()
        } catch (error) {
          if (!abort.signal.aborted) {
            // Queued authoritative results survive a following SDK exception.
            outputQueue.close(error)
            stop()
          }
        }
      })()
      return session
    } catch (error) {
      queryDispatched ||= client?.requiresRuntimeClosure?.() ?? false
      await session.close()
      throw error
    }
  }
  return runner
}
