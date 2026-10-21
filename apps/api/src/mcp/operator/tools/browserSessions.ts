import type { BrowserOperatorToolDefinition } from '../../../modules/browser-runtime/operatorDefinition.js'
import { hasAction } from '../../../modules/access/policy.js'
import { bindBrowserOperation, browserSessionOperationNames, type BrowserCanonicalCodecs, type BrowserOperationHandlers, type BrowserOperationName } from '../../../modules/browser-runtime/operations.js'

const readNames = new Set<BrowserOperationName>(['browser_sessions_list', 'browser_session_get', 'browser_tabs_list', 'browser_state_read', 'browser_screenshot', 'browser_view_open', 'browser_view_read', 'browser_view_close'])
const descriptions: Record<typeof browserSessionOperationNames[number], string> = {
  browser_session_open: 'Prepare the exact enabled saved subject, open a settings setup session, reconnect its owned process, or use an explicit native-window intent. Canonical unavailable reasons are truthful; no invented Run or new browser agent is created.',
  browser_sessions_list: 'List authorized browser sessions for the exact selected subject, profile setup or computer, with bounded cursor pagination.',
  browser_session_get: 'Read exact session, control epoch, owned tabs and safe action/file/dialog facts, including retained completed output after close.',
  browser_session_close: 'Close only this session’s owned tabs. Pending means native cleanup has not yet been proven; profile storage and sibling sessions survive.',
  browser_tabs_list: 'List only tabs leased to this exact browser session and generation.',
  browser_tab_create: 'Create one owned browser tab. A viewer-created tab does not move the agent’s logical focus. Preserve command ID on lost response.',
  browser_tab_select: 'Select an owned tab for the agent or viewer. Viewer selection never changes agent focus.',
  browser_tab_close: 'Close exactly one owned tab, with generation/control checks and idempotent command reconciliation.',
  browser_state_read: 'Read bounded page state from one owned tab. Agent reads wait while the user controls the browser; no browser-wide CDP is exposed.',
  browser_screenshot: 'Read a bounded screenshot of one owned tab through the same subject/generation/control fence as other browser observations.',
  browser_action: 'Perform typed page actions or owned upload/download phases. Every nested native dispatch is fenced; no arbitrary Python/CDP. Unknown outcomes require readback, not blind replay.',
  browser_view_open: 'Open an authenticated bounded viewer for one owned tab. Returns a view descriptor, never a raw CDP endpoint.',
  browser_view_read: 'Read the newest bounded frame after a cursor for this authenticated view. Ordinary device command slots do not carry live stream traffic.',
  browser_view_close: 'Retire a viewer subscription idempotently. Explicit tab/view replacement preserves held control; unexpected viewer loss pauses it.',
  browser_control_acquire: 'Take control only after the host fences agent reads/writes and reaches a safe boundary. The acknowledged viewer identity and epoch own subsequent input.',
  browser_control_release: 'Resume the exact agent only after pressed input is released and current page state refreshed, or explicitly pause without resuming on viewer loss.',
  browser_input: 'Submit bounded ordered page gestures for the acknowledged controlling viewer and exact epoch/generation. Stale and duplicate input never replays.',
}

export function createBrowserSessionTools(handlers: BrowserOperationHandlers, codecs: BrowserCanonicalCodecs) {
  return browserSessionOperationNames.map((name): BrowserOperatorToolDefinition => {
    const read = readNames.has(name)
    return { name, description: descriptions[name], inputSchema: codecs[name].inputSchema,
      ...(codecs[name].outputSchema ? { outputSchema: codecs[name].outputSchema } : {}),
      requires: [[read ? 'workflows:read' : 'workflows:update', 'resource']],
      discoverable: context => hasAction(context.principal, read ? 'workflows:read' : 'workflows:update')
        || hasAction(context.principal, read ? 'settings:read' : 'settings:update'),
      annotations: { readOnlyHint: read, destructiveHint: name === 'browser_session_close' || name === 'browser_tab_close', idempotentHint: name !== 'browser_input', openWorldHint: true },
      run: (context, input) => bindBrowserOperation(name, handlers, codecs).mcp(context.principal, input) }
  })
}

/** D's unified registry applies existing effective tool visibility, sandbox and exact subject credentials. */
export function createBrowserAgentHandlers(handlers: BrowserOperationHandlers, codecs: BrowserCanonicalCodecs) {
  const allowed = ['browser_session_open', 'browser_session_get', 'browser_session_close', 'browser_tabs_list',
    'browser_tab_create', 'browser_tab_select', 'browser_tab_close', 'browser_state_read', 'browser_screenshot', 'browser_action'] as const
  return allowed.map(name => ({ name, inputSchema: codecs[name].inputSchema, readOnly: readNames.has(name),
    invoke: bindBrowserOperation(name, handlers, codecs).mcp }))
}
