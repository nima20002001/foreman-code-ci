import type { z } from 'zod'
import type { AgentSubjectSchema } from '@foreman-code/contracts/agent-identity'
import type { BrowserControlSchema, BrowserPrepareResultSchema, BrowserSessionSchema, BrowserTabLeaseSchema } from '@foreman-code/contracts/browser-sessions'
import type { NodeBrowserSettingsSchema } from '@foreman-code/contracts/browser-profiles'
import type { BrowserFileLabel } from './transferTypes'

export type AgentSubject = z.infer<typeof AgentSubjectSchema>
export type BrowserSession = z.infer<typeof BrowserSessionSchema>
export type BrowserControl = z.infer<typeof BrowserControlSchema>
export type BrowserPrepareResult = z.infer<typeof BrowserPrepareResultSchema>
export type BrowserTabLease = z.infer<typeof BrowserTabLeaseSchema>
export type NodeBrowserSettings = z.infer<typeof NodeBrowserSettingsSchema>

/** In-process viewer adapter values. These are not HTTP/MCP schemas. C0 owns the wire. */
export type PageGesture =
  | { kind: 'pointer'; phase: 'move' | 'down' | 'up'; x: number; y: number; button: number; buttons: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; phase: 'down' | 'up'; key: string; code: string; alt: boolean; control: boolean; meta: boolean; shift: boolean; repeat: boolean }
  | { kind: 'composition'; phase: 'start' | 'update' | 'end'; text: string }

export interface PageFrame {
  sessionId: string
  browserGeneration: number
  tabId: string
  sequence: number
  width: number
  height: number
  /** Host viewport inset in DIP; input coordinates exclude this non-page strip. */
  viewportOffsetTop?: number
  capturedAt: string
  image: Blob
}

export interface BrowserViewObserver {
  frame(frame: PageFrame): void
  control(control: BrowserControl): void
  disconnected(error: unknown): void
}

export interface BrowserViewConnection {
  close(): Promise<void>
}

export interface BrowserSessionRead {
  session: BrowserSession
  control: BrowserControl
  tabs: BrowserTabLease[]
  uploadChooser: { tabId: string; selector: string } | null
  files: BrowserFileLabel[]
  dialog: { tabId: string; type: 'alert' | 'confirm' | 'prompt'; message: string; defaultPrompt?: string } | null
}

/** Bound by D composition to the canonical session API; never given a CDP address. */
export interface BrowserUiPort {
  prepare(subject: AgentSubject, browser: NodeBrowserSettings, computerId: string, commandId: string): Promise<BrowserPrepareResult>
  listSessions(subject: AgentSubject, signal: AbortSignal): Promise<BrowserSession[]>
  listSetupSessions(profileId: string, computerId: string, signal: AbortSignal): Promise<BrowserSession[]>
  readSession(sessionId: string, signal: AbortSignal): Promise<BrowserSessionRead>
  reconnect(session: BrowserSession, commandId: string): Promise<BrowserSessionRead>
  acquire(session: BrowserSession, viewerId: string, commandId: string): Promise<BrowserControl>
  release(session: BrowserSession, viewerId: string, epoch: number, commandId: string): Promise<BrowserControl>
  pause(session: BrowserSession, viewerId: string, epoch: number, commandId: string): Promise<BrowserControl>
  openView(session: BrowserSession, tab: BrowserTabLease, viewerId: string,
    observer: BrowserViewObserver, signal: AbortSignal): Promise<BrowserViewConnection>
  input(session: BrowserSession, tab: BrowserTabLease, viewerId: string, epoch: number,
    firstSequence: number, gestures: readonly PageGesture[], signal: AbortSignal): Promise<void>
  releasePressed(session: BrowserSession, viewerId: string, epoch: number): Promise<void>
  selectTab(session: BrowserSession, tabId: string, viewerId: string, epoch: number, commandId: string): Promise<BrowserSessionRead>
  createTab(session: BrowserSession, viewerId: string, epoch: number, commandId: string): Promise<BrowserSessionRead & { createdTabId: string }>
  closeTab(session: BrowserSession, tabId: string, viewerId: string, epoch: number, commandId: string): Promise<BrowserSessionRead>
  navigate(session: BrowserSession, tab: BrowserTabLease, viewerId: string, epoch: number,
    url: string, commandId: string): Promise<BrowserSessionRead>
  respondDialog(session: BrowserSession, tab: BrowserTabLease, viewerId: string, epoch: number,
    accept: boolean, prompt: string | undefined, commandId: string): Promise<BrowserSessionRead>
  openLocalBrowser(session: BrowserSession, viewerId: string, epoch: number, commandId: string): Promise<BrowserControl>
  closeSession(session: BrowserSession, commandId: string): Promise<'closed' | 'pending' | 'already_closed'>
}

/** URL/shell ownership stays with D. A visit key must change even on A → B → A. */
export interface BrowserSelection {
  authBoundary: string
  visitKey: string
  subject: AgentSubject
  sessionId: string | null
  tabId: string | null
  enabled: boolean
  historical: boolean
}

export type BrowserPanelNotice = 'watching' | 'taking' | 'user' | 'returning' | 'paused' | 'denied' | 'closed'

export interface BrowserControllerSnapshot {
  notice: BrowserPanelNotice
  control: BrowserControl
  error: string | null
  frame: PageFrame | null
  stale: boolean
  pendingInputs: number
}
