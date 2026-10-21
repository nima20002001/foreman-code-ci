import type { BrowserOperatorToolDefinition } from '../../../modules/browser-runtime/operatorDefinition.js'
import { bindBrowserOperation, browserProfileOperationNames, type BrowserCanonicalCodecs, type BrowserOperationHandlers } from '../../../modules/browser-runtime/operations.js'

const descriptions = {
  browser_profiles_list: 'List a bounded page of managed browser profiles and authorized computer replica facts. Snapshot freshness and per-origin sign-in evidence are separate.',
  browser_profile_get: 'Read one managed profile, its stable source computer, replica state and pending maintenance facts without exposing profile paths or secrets.',
  browser_profile_create: 'Create a managed browser profile or explicitly add an existing profile to one computer. Returns queued/first-snapshot-pending until the native host confirms readiness.',
  browser_profile_update: 'Rename a profile, choose its source/distribution, set an explicit local override, or confirm/check one origin. Clearing an override changes policy only; sync explicitly to apply source state.',
  browser_profile_remove: 'Queue removal of only the requested owned replica or logical profile. Busy/offline cleanup remains pending and historical references remain stable.',
  browser_profiles_sync: 'Admit an explicit browser profile sync job. Capture the selected source, encrypt immutable supported state and apply to the admitted eligible computer installations. Same command ID reconciles one job.',
  browser_profile_sync_get: 'Read a sync job with bounded source/target cursor pages, including offline, excluded, waiting-idle and failed destinations. Imported bytes do not prove website sign-in.',
} as const

export function createBrowserProfileTools(handlers: BrowserOperationHandlers, codecs: BrowserCanonicalCodecs) {
  return browserProfileOperationNames.map((name): BrowserOperatorToolDefinition => {
    const read = name === 'browser_profiles_list' || name === 'browser_profile_get' || name === 'browser_profile_sync_get'
    return { name, description: descriptions[name], inputSchema: codecs[name].inputSchema,
      ...(codecs[name].outputSchema ? { outputSchema: codecs[name].outputSchema } : {}),
      requires: [[read ? 'settings:read' : 'settings:update', 'global']],
      annotations: { readOnlyHint: read, destructiveHint: name === 'browser_profile_remove', idempotentHint: true, openWorldHint: true },
      run: (context, input) => bindBrowserOperation(name, handlers, codecs).mcp(context.principal, input) }
  })
}
