import type { z } from 'zod'
import type { AgentSubjectSchema } from '@foreman-code/contracts/agent-identity'
import type { NodeBrowserSettingsSchema } from '@foreman-code/contracts/browser-profiles'
import type { BrowserSessionSchema, BrowserTabLeaseSchema, BrowserControlSchema,
  BrowserPrepareResultSchema, BrowserReleaseResultSchema } from '@foreman-code/contracts/browser-sessions'

export type AgentSubject = z.infer<typeof AgentSubjectSchema>
export type NodeBrowserSettings = z.infer<typeof NodeBrowserSettingsSchema>
export type BrowserSession = z.infer<typeof BrowserSessionSchema>
export type BrowserTabLease = z.infer<typeof BrowserTabLeaseSchema>
export type BrowserControl = z.infer<typeof BrowserControlSchema>
export type BrowserPrepareResult = z.infer<typeof BrowserPrepareResultSchema>
export type BrowserReleaseResult = z.infer<typeof BrowserReleaseResultSchema>

/** Host-private actions: never exported as replacement HTTP/MCP schemas. */
export type BrowserHostAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'back' | 'forward' | 'reload' }
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { kind: 'type'; text: string }
  | { kind: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; key: string; modifiers?: number }
  | { kind: 'dialog'; accept: boolean; promptText?: string }
  | { kind: 'upload'; fileId: string; selector: string }
  | { kind: 'download'; downloadId: string; intent: 'read' | 'delete' }

export type BrowserPageInput =
  | { kind: 'pointer'; phase: 'move' | 'down' | 'up'; x: number; y: number; button: number; buttons: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; phase: 'down' | 'up'; key: string; code: string; alt: boolean; control: boolean; meta: boolean; shift: boolean; repeat: boolean }
  | { kind: 'composition'; phase: 'start' | 'update' | 'end'; text: string }

export interface BrowserHostFrame { data: Uint8Array; mimeType: 'image/jpeg' | 'image/png'; width: number; height: number; viewportOffsetTop: number; capturedAt: string }
export interface BrowserPageObservation { title: string; url: string; text: string; dialog: { type: string; message: string; defaultPrompt?: string } | null }
export interface BrowserNativeFacts { dialog: BrowserPageObservation['dialog']; uploadChooser: { selector: string; multiple: boolean } | null }
export interface BrowserNativeDownload {
  profileId: string; generation: number; targetId: string; nativeId: string; name: string; byteLength: number
  receivedBytes: number; state: 'inProgress' | 'completed' | 'canceled'; privatePath: string
}
export interface NativeBrowserTab { targetId: string; title: string; url: string }
export interface NativeBrowserProfile { generation: number }

/** The native adapter is private. All CDP sends, including helper follow-ups, re-enter checked dispatch. */
export interface BrowserNativeDriver {
  openProfile(profileId: string): Promise<NativeBrowserProfile>
  closeProfile(profileId: string): Promise<void>
  settlePopups(profileId: string, generation: number): Promise<void>
  reconnectProfile(profileId: string): Promise<NativeBrowserProfile | null>
  restoreTab(profileId: string, generation: number, targetId: string): Promise<NativeBrowserTab | null>
  createTab(profileId: string, generation: number, allocationToken?: string): Promise<NativeBrowserTab>
  closeTab(profileId: string, generation: number, targetId: string): Promise<void>
  dispatch(profileId: string, generation: number, targetId: string, method: string, params: Record<string, unknown>): Promise<unknown>
  action(action: BrowserHostAction, dispatch: BrowserNativeDispatch): Promise<unknown>
  observe(dispatch: BrowserNativeDispatch): Promise<BrowserPageObservation>
  input(input: BrowserPageInput, dispatch: BrowserNativeDispatch): Promise<void>
  releasePressed(dispatch: BrowserNativeDispatch): Promise<void>
  capture(profileId: string, generation: number, targetId: string, frame: (value: BrowserHostFrame) => void): Promise<() => Promise<void>>
  openLocal(profileId: string, generation: number, targetId: string): Promise<void>
  facts(profileId: string, generation: number, targetId: string): BrowserNativeFacts
  onTabClosed(listener: (profileId: string, generation: number, targetId: string) => void): () => void
  onPopup(listener: (profileId: string, generation: number, openerTargetId: string, tab: NativeBrowserTab) => void | Promise<void>): () => void
}
export type BrowserNativeDispatch = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export interface BrowserPreparedBinding {
  subject: AgentSubject; browser: NodeBrowserSettings; computerId: string; readOnly: boolean
  availability: 'ready' | Exclude<Extract<BrowserPrepareResult, { kind: 'unavailable' }>['reason'], 'disabled'>
}
export interface BrowserSubjectAuthority {
  /** Resolve exact saved configuration and existing credential scope; never accept caller-invented subject authority. */
  resolve(subject: AgentSubject): Promise<BrowserPreparedBinding>
  assertCurrent(subject: AgentSubject): Promise<void>
}

export interface BrowserRuntimeReceipt {
  inputHash: string; state: 'reserved' | 'completed' | 'unknown' | 'rejected'; value?: unknown
  rejection?: { code: string; message: string; status: number }
}
export interface BrowserRuntimeJournal {
  read(key: string): Promise<BrowserRuntimeReceipt | undefined>
  write(key: string, receipt: BrowserRuntimeReceipt): Promise<void>
  saveSession(value: BrowserRuntimeSessionRecord): Promise<void>
  loadSessions(): Promise<BrowserRuntimeSessionRecord[]>
}
export interface BrowserRuntimeSessionRecord {
  session: BrowserSession; control: BrowserControl; readOnly: boolean
  leases: Array<{ lease: BrowserTabLease; targetId: string }>
  /** Private replay and owner lifecycle identity; no secrets, input text, or frames. */
  prepareCommandId: string; closing: boolean
  viewerDisconnected?: boolean
}

export interface BrowserActor {
  kind: 'agent' | 'viewer'
  viewerId?: string
  epoch: number
  browserGeneration: number
}

export interface BrowserRuntimeView {
  id: string; sessionId: string; tabId: string; browserGeneration: number
}
