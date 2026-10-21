import { createBrowserHttp, browserSessionPath, type BrowserHttpOptions, type BrowserMethodCodec, type BrowserWireCodec } from './http'
import type { AgentSubject, BrowserControl, BrowserSession, BrowserTabLease, BrowserUiPort, PageFrame } from './types'
import type { BrowserFilesPort } from './transferTypes'
import { connectBrowserView, type BrowserMediaCodec } from './viewTransport'

type CommandMethods = Exclude<keyof BrowserUiPort, 'openView' | 'listSessions' | 'listSetupSessions'>
type SessionPage = { sessions: BrowserSession[]; nextCursor: string | null }
export type BrowserCommandCodecs = { [Key in CommandMethods]: BrowserMethodCodec<BrowserUiPort[Key]> } & {
  listSessions: BrowserWireCodec<[AgentSubject, string | null, AbortSignal], SessionPage>
  listSetupSessions: BrowserWireCodec<[string, string, string | null, AbortSignal], SessionPage>
}

async function collectSessions(read: (cursor: string | null) => Promise<SessionPage>, signal: AbortSignal) {
  const sessions = new Map<string, BrowserSession>(), seen = new Set<string>()
  let cursor: string | null = null
  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    signal.throwIfAborted()
    const page = await read(cursor)
    for (const session of page.sessions) sessions.set(session.id, session)
    if (!page.nextCursor) return [...sessions.values()]
    if (seen.has(page.nextCursor)) throw new Error('Browser session history pagination did not advance.')
    cursor = page.nextCursor; seen.add(cursor)
  }
  throw new Error('Browser session history is too large to read in one view.')
}

/** C0 browser_view_open/read/close envelope projections. Each read is bounded; no image query cache. */
export interface BrowserViewCodecs {
  open: BrowserWireCodec<[BrowserSession, BrowserTabLease, string, string], { viewId: string }>
  read: BrowserWireCodec<[BrowserSession, string, number], { frame?: PageFrame; control?: BrowserControl; closed?: boolean }>
  close: BrowserWireCodec<[BrowserSession, string, string], void>
  media: BrowserMediaCodec
}

/** Concrete canonical-route mapping; codec callbacks only translate C0 envelopes. */
export function createBrowserUiClient(options: BrowserHttpOptions & { commands: BrowserCommandCodecs; views: BrowserViewCodecs; socket?: typeof WebSocket }): BrowserUiPort {
  const call = createBrowserHttp(options), codec = options.commands, path = browserSessionPath
  return {
    prepare: (...args) => call('POST', '/api/browser/sessions/open', codec.prepare, args),
    listSessions: (subject, signal) => collectSessions(cursor => call('GET', '/api/browser/sessions', codec.listSessions,
      [subject, cursor, signal], signal), signal),
    listSetupSessions: (profileId, computerId, signal) => collectSessions(cursor => call('GET', '/api/browser/sessions', codec.listSetupSessions,
      [profileId, computerId, cursor, signal], signal), signal),
    readSession: (...args) => call('GET', path(args[0]), codec.readSession, args, args[1]),
    reconnect: (...args) => call('POST', '/api/browser/sessions/open', codec.reconnect, args),
    acquire: (...args) => call('POST', `${path(args[0].id)}/control/acquire`, codec.acquire, args),
    release: (...args) => call('POST', `${path(args[0].id)}/control/release`, codec.release, args),
    pause: (...args) => call('POST', `${path(args[0].id)}/control/release`, codec.pause, args),
    input: (...args) => call('POST', `${path(args[0].id)}/input`, codec.input, args, args[6]),
    releasePressed: (...args) => call('POST', `${path(args[0].id)}/input`, codec.releasePressed, args),
    selectTab: (...args) => call('POST', `${path(args[0].id)}/tabs/${encodeURIComponent(args[1])}/select`, codec.selectTab, args),
    createTab: (...args) => call('POST', `${path(args[0].id)}/tabs`, codec.createTab, args),
    closeTab: (...args) => call('DELETE', `${path(args[0].id)}/tabs/${encodeURIComponent(args[1])}`, codec.closeTab, args),
    navigate: (...args) => call('POST', `${path(args[0].id)}/actions`, codec.navigate, args),
    respondDialog: (...args) => call('POST', `${path(args[0].id)}/actions`, codec.respondDialog, args),
    openLocalBrowser: (...args) => call('POST', '/api/browser/sessions/open', codec.openLocalBrowser, args),
    closeSession: (...args) => call('POST', `${path(args[0].id)}/close`, codec.closeSession, args),
    openView: async (session, tab, viewerId, observer, signal) => {
      const admission = crypto.randomUUID(), retirement = crypto.randomUUID()
      // Do not abort allocation: a late view ID must be closed, even when the view has retired.
      const receipt = await call('POST', `${path(session.id)}/views`, options.views.open, [session, tab, viewerId, admission])
      const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal])
      const endpoint = `${path(session.id)}/views/${encodeURIComponent(receipt.viewId)}`
      let closing: Promise<void> | undefined
      let media: { close(): void } | undefined
      const close = () => {
        signal.removeEventListener('abort', retired)
        closing ??= call('DELETE', endpoint, options.views.close, [session, receipt.viewId, retirement])
        abort.abort(); media?.close()
        return closing
      }
      const retired = () => { void close().catch(error => observer.disconnected(error)) }
      if (signal.aborted) { await close(); return { close } }
      signal.addEventListener('abort', retired, { once: true })
      try {
        media = connectBrowserView({ sessionId: session.id, viewId: receipt.viewId, signal: combined, codec: options.views.media,
          origin: options.origin, socket: options.socket, observer: { ...observer, disconnected: error => {
            observer.disconnected(error)
            void close().catch(failure => observer.disconnected(failure))
          } } })
      } catch (error) { await close(); throw error }
      return { close }
    },
  }
}

export type BrowserFileCodecs = { [Key in keyof BrowserFilesPort]: BrowserMethodCodec<BrowserFilesPort[Key]> }

export function createBrowserFilesClient(options: BrowserHttpOptions & { files: BrowserFileCodecs }): BrowserFilesPort {
  const call = createBrowserHttp(options), codec = options.files, path = browserSessionPath
  return {
    begin: (...args) => call('POST', `${path(args[0].id)}/uploads`, codec.begin, args),
    write: (...args) => call('PUT', `${path(args[0].id)}/uploads/${encodeURIComponent(args[1])}/bytes`, codec.write, args, args[4]),
    finish: (...args) => call('POST', `${path(args[0].id)}/uploads/${encodeURIComponent(args[1])}/finish`, codec.finish, args),
    attach: (...args) => call('POST', `${path(args[0].id)}/actions`, codec.attach, args),
    cancel: (...args) => call('DELETE', `${path(args[0].id)}/uploads/${encodeURIComponent(args[1])}`, codec.cancel, args),
    read: (...args) => call('GET', `${path(args[0].id)}/files/${encodeURIComponent(args[1])}/bytes`, codec.read, args, args[4]),
    remove: (...args) => call('DELETE', `${path(args[0].id)}/files/${encodeURIComponent(args[1])}`, codec.remove, args),
  }
}
