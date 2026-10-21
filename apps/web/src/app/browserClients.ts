import { ApiErrorResponseSchema, BrowserOperationRequestSchemas, BrowserOperationResponseSchemas,
  BrowserProfileCatalogSchema, BrowserProfileAddResultSchema, BrowserProfileSchema, BrowserProfileReplicaSchema, BrowserProfileSyncJobSchema,
  BrowserProfileSyncPageSchema, BrowserSessionSchema, BrowserSessionDetailsSchema, BrowserControlSchema,
  BrowserPrepareResultSchema, BrowserReleaseResultSchema, BrowserFileSchema, BrowserRuntimeViewSchema,
  BrowserViewerHelloSchema, BrowserViewerMessageSchema, decodeBrowserBinaryFrame,
  type BrowserOperationName, type BrowserSession } from '@foreman-code/contracts'
import { z } from 'zod'
import { createBrowserUiClient, createBrowserFilesClient, type BrowserCommandCodecs,
  type BrowserViewCodecs, type BrowserFileCodecs } from '../features/agent-browser/client'
import { createBrowserProfilesClient, type BrowserProfileCodecs } from '../features/browser-profiles/client'
import type { BrowserWireCodec, BrowserHttpOptions } from '../features/agent-browser/http'

function wire<Arguments extends readonly unknown[], Result>(name: BrowserOperationName,
  input: (...args: Arguments) => unknown, output: (value: unknown, args: Arguments) => Result | Promise<Result>,
  encoding: 'json' | 'query' = 'json'): BrowserWireCodec<Arguments, Result> {
  return {
    encode: (...args) => {
      const value = BrowserOperationRequestSchemas[name].parse(input(...args))
      return encoding === 'query' ? { query: new URLSearchParams({ input: JSON.stringify(value) }) } : { json: value }
    },
    decode: async (response, args) => output(BrowserOperationResponseSchemas[name].parse(await response.json()), args),
  }
}
const value = <T>(schema: z.ZodType<T>) => (receipt: unknown) => schema.parse((receipt as { value: unknown }).value)
const read = <T>(schema: z.ZodType<T>) => (input: unknown) => schema.parse(input)
const discard = () => undefined
const actor = (session: BrowserSession, viewerId: string, epoch: number) => ({
  kind: 'viewer' as const, viewerId, epoch, browserGeneration: session.browserGeneration,
})
const session = (result: unknown) => {
  const prepared = result as { kind?: string; reason?: string; session?: unknown }
  if (prepared.kind === 'unavailable') throw new Error(`Browser unavailable: ${prepared.reason}`)
  return BrowserSessionSchema.parse(prepared.session)
}
const http: BrowserHttpOptions = { async error(response) {
  const body = await response.text()
  let data: unknown
  try { data = JSON.parse(body) } catch { return { message: `Browser request failed (${response.status}).` } }
  const parsed = ApiErrorResponseSchema.safeParse(data)
  return parsed.success ? { message: parsed.data.error.message, code: parsed.data.error.code }
    : { message: `Browser request failed (${response.status}).` }
} }

const profiles: BrowserProfileCodecs = {
  readCatalog: wire('browser_profiles_list', (cursor, signal) => { signal.throwIfAborted(); return { ...(cursor ? { cursor } : {}) } }, read(BrowserProfileCatalogSchema), 'query'),
  create: wire('browser_profile_create', (name, computerId, distribution, commandId) => ({ name, computerId, distribution, commandId }), value(BrowserProfileSchema)),
  addExisting: wire('browser_profile_create', (profileId, computerId, commandId) => ({ intent: 'add_existing', profileId, computerId, commandId }),
    value(BrowserProfileAddResultSchema)),
  update: wire('browser_profile_update', (profileId, patch, commandId) => ({ intent: 'metadata', profileId, patch, commandId }), value(BrowserProfileSchema)),
  setLocalOverride: wire('browser_profile_update', (profileId, computerId, localOverride, commandId) => ({ intent: 'local_override', profileId, computerId, localOverride, commandId }), value(BrowserProfileReplicaSchema)),
  confirmLogin: wire('browser_profile_update', (profileId, computerId, origin, state, commandId) => ({ intent: 'confirm_login', profileId, computerId, origin, state, commandId }), value(BrowserProfileReplicaSchema)),
  remove: wire('browser_profile_remove', (profileId, computerId, commandId) => ({ profileId, computerId, commandId }), receipt => {
    const intents = (receipt as { value: Array<{ state: string }> }).value
    return intents.every(intent => intent.state === 'completed') ? 'removed' : 'queued'
  }),
  openSetup: wire('browser_session_open', (profileId, computerId, commandId) => ({ intent: 'setup', profileId, computerId, commandId }), session),
  closeSetup: wire('browser_session_close', (selected, commandId) => ({ sessionId: selected.id, commandId }), result => BrowserReleaseResultSchema.parse(result).state),
  sync: wire('browser_profiles_sync', (profileIds, commandId) => ({ profileIds, commandId }), value(BrowserProfileSyncJobSchema)),
  readSync: wire('browser_profile_sync_get', (jobId, profileCursor, targetCursor, signal) => { signal.throwIfAborted(); return { jobId,
    ...(profileCursor ? { profileCursor } : {}), ...(targetCursor ? { targetCursor } : {}) } }, read(BrowserProfileSyncPageSchema), 'query'),
}
const commands: BrowserCommandCodecs = {
  prepare: wire('browser_session_open', (subject, browser, computerId, commandId) => ({ intent: 'prepare', request: { subject, browser, computerId, commandId } }), read(BrowserPrepareResultSchema)),
  listSessions: wire('browser_sessions_list', (subject, cursor, signal) => { signal.throwIfAborted(); return { subject, ...(cursor ? { cursor } : {}) } },
    result => result as { sessions: BrowserSession[]; nextCursor: string | null }, 'query'),
  listSetupSessions: wire('browser_sessions_list', (setupForProfileId, computerId, cursor, signal) => { signal.throwIfAborted(); return { setupForProfileId, computerId, ...(cursor ? { cursor } : {}) } },
    result => result as { sessions: BrowserSession[]; nextCursor: string | null }, 'query'),
  readSession: wire('browser_session_get', (sessionId, signal) => { signal.throwIfAborted(); return { sessionId } }, read(BrowserSessionDetailsSchema), 'query'),
  reconnect: wire('browser_session_open', (selected, commandId) => ({ intent: 'reconnect', sessionId: selected.id, commandId }), read(BrowserSessionDetailsSchema)),
  acquire: wire('browser_control_acquire', (selected, viewerId, commandId) => ({ sessionId: selected.id, viewerId, browserGeneration: selected.browserGeneration, commandId }), read(BrowserControlSchema)),
  release: wire('browser_control_release', (selected, viewerId, epoch, commandId) => ({ sessionId: selected.id, viewerId, epoch, commandId }), read(BrowserControlSchema)),
  pause: wire('browser_control_release', (selected, viewerId, epoch, commandId) => ({ intent: 'pause', sessionId: selected.id, viewerId, epoch, commandId }), read(BrowserControlSchema)),
  input: wire('browser_input', (selected, tab, viewerId, epoch, firstSequence, gestures, signal) => { signal.throwIfAborted(); return { sessionId: selected.id, tabId: tab.tabId,
    actor: actor(selected, viewerId, epoch), firstSequence, gestures } }, discard),
  releasePressed: wire('browser_input', (selected, viewerId, epoch) => ({ intent: 'release_pressed', sessionId: selected.id, actor: actor(selected, viewerId, epoch) }), discard),
  selectTab: wire('browser_tab_select', (selected, tabId, viewerId, epoch, commandId) => ({ sessionId: selected.id, tabId, actor: actor(selected, viewerId, epoch), commandId }), read(BrowserSessionDetailsSchema)),
  createTab: wire('browser_tab_create', (selected, viewerId, epoch, commandId) => ({ sessionId: selected.id, actor: actor(selected, viewerId, epoch), commandId }),
    result => { const selected = BrowserSessionDetailsSchema.parse(result); if (!selected.createdTabId) throw new Error('The created browser tab is missing.'); return { ...selected, createdTabId: selected.createdTabId } }),
  closeTab: wire('browser_tab_close', (selected, tabId, viewerId, epoch, commandId) => ({ sessionId: selected.id, tabId, actor: actor(selected, viewerId, epoch), commandId }), read(BrowserSessionDetailsSchema)),
  navigate: wire('browser_action', (selected, tab, viewerId, epoch, url, commandId) => ({ sessionId: selected.id, tabId: tab.tabId, actor: actor(selected, viewerId, epoch), commandId, action: { kind: 'navigate', url } }),
    (_result, args) => browserClient.readSession(args[0].id, new AbortController().signal)),
  respondDialog: wire('browser_action', (selected, tab, viewerId, epoch, accept, promptText, commandId) => ({ sessionId: selected.id, tabId: tab.tabId, actor: actor(selected, viewerId, epoch), commandId, action: { kind: 'dialog', accept, promptText } }),
    (_result, args) => browserClient.readSession(args[0].id, new AbortController().signal)),
  openLocalBrowser: wire('browser_session_open', (selected, viewerId, epoch, commandId) => ({ intent: 'native_window', sessionId: selected.id,
    tabId: selected.selectedTabId, actor: actor(selected, viewerId, epoch), commandId }), read(BrowserControlSchema)),
  closeSession: wire('browser_session_close', (selected, commandId) => ({ sessionId: selected.id, commandId }), result => BrowserReleaseResultSchema.parse(result).state),
}
const views: BrowserViewCodecs = {
  open: wire('browser_view_open', (selected, tab, viewerId, commandId) => ({ sessionId: selected.id, tabId: tab.tabId,
    viewerId, browserGeneration: selected.browserGeneration, commandId }), result => ({ viewId: BrowserRuntimeViewSchema.parse(result).id })),
  read: wire('browser_view_read', (_selected, viewId, after) => ({ viewId, after }), result => {
    const readback = BrowserOperationResponseSchemas.browser_view_read.parse(result)
    if (!readback.frame) return {}
    const { contentBase64, mimeType, byteLength, ...metadata } = readback.frame
    const bytes = Uint8Array.from(atob(contentBase64), character => character.charCodeAt(0))
    if (bytes.byteLength !== byteLength) throw new Error('Browser frame length changed in transit.')
    return { frame: { ...metadata, image: new Blob([bytes], { type: mimeType }) } }
  }, 'query'),
  close: wire<Parameters<BrowserViewCodecs['close']['encode']>, void>('browser_view_close', (_selected, viewId) => ({ viewId }), discard),
  media: {
    hello: (viewId, installationId) => JSON.stringify(BrowserViewerHelloSchema.parse({ viewId, installationId })),
    decode(input) {
      if (typeof input === 'string') {
        const message = BrowserViewerMessageSchema.parse(JSON.parse(input))
        if (message.kind === 'frame') throw new Error('Browser frame bytes require the binary channel.')
        return message
      }
      const { header, bytes } = decodeBrowserBinaryFrame(new Uint8Array(input))
      const message = BrowserViewerMessageSchema.parse(header)
      if (message.kind !== 'frame') throw new Error('Binary browser input must be a frame.')
      return { ...message, bytes }
    },
  },
}
const files: BrowserFileCodecs = {
  begin: wire('browser_action', (selected, tab, file, commandId) => ({ intent: 'file', phase: 'begin', sessionId: selected.id,
    tabId: tab.tabId, browserGeneration: selected.browserGeneration, commandId, name: file.name, mimeType: file.type, byteLength: file.size }), read(BrowserFileSchema)),
  write: { encode: (selected, fileId, offset, bytes) => ({ bytes, query: new URLSearchParams({ input: JSON.stringify({ intent: 'file', phase: 'write', sessionId: selected.id, fileId, offset }) }) }), decode: async response => { BrowserOperationResponseSchemas.browser_action.parse(await response.json()) } },
  finish: wire('browser_action', (selected, fileId, commandId) => ({ intent: 'file', phase: 'finish', sessionId: selected.id, fileId, commandId }), read(BrowserFileSchema)),
  attach: wire('browser_action', (selected, tab, fileId, selector, commandId, control) => ({ intent: 'file', phase: 'attach', sessionId: selected.id,
    tabId: tab.tabId, actor: actor(selected, control.viewerId, control.epoch), fileId, selector, commandId }), read(BrowserFileSchema)),
  cancel: wire('browser_action', (selected, fileId, commandId) => ({ intent: 'file', phase: 'cancel', sessionId: selected.id, fileId, commandId }), read(BrowserFileSchema)),
  read: { encode: (selected, fileId, offset, length) => ({ query: new URLSearchParams({ input: JSON.stringify({ intent: 'file', phase: 'read', sessionId: selected.id, fileId, offset, length }) }) }),
    decode: async response => { const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > 262_144) throw new Error('The browser file chunk exceeds 256 KiB.'); return bytes } },
  remove: wire('browser_action', (selected, fileId, commandId) => ({ intent: 'file', phase: 'remove', sessionId: selected.id, fileId, commandId }), discard),
}
export const browserProfilesClient = createBrowserProfilesClient({ ...http, profiles })
const browserClient = createBrowserUiClient({ ...http, commands, views })
export const browserFilesClient = createBrowserFilesClient({ ...http, files })
export const browserUiClient = browserClient
