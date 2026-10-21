import { randomUUID } from 'node:crypto'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import type { BrowserProfileService } from '../browser-profiles/service.js'
import { admitBrowserProfileSync, readBrowserProfileSync } from '../browser-profiles/sync.js'
import type { BrowserSessionPort } from './service.js'
import type { BrowserBroker } from './broker.js'

export const browserProfileOperationNames = ['browser_profiles_list', 'browser_profile_get', 'browser_profile_create',
  'browser_profile_update', 'browser_profile_remove', 'browser_profiles_sync', 'browser_profile_sync_get'] as const
export const browserSessionOperationNames = ['browser_session_open', 'browser_sessions_list', 'browser_session_get', 'browser_session_close',
  'browser_tabs_list', 'browser_tab_create', 'browser_tab_select', 'browser_tab_close', 'browser_state_read', 'browser_screenshot',
  'browser_action', 'browser_view_open', 'browser_view_read', 'browser_view_close', 'browser_control_acquire', 'browser_control_release', 'browser_input'] as const
export type BrowserOperationName = typeof browserProfileOperationNames[number] | typeof browserSessionOperationNames[number]

type Profiles = BrowserProfileService
type Sessions = BrowserSessionPort<ManagementPrincipal>
type OptionalCommand<T> = T extends unknown ? Omit<T, 'commandId'> & { commandId?: string } : never
export interface BrowserOperationInputs {
  browser_profiles_list: Parameters<Profiles['catalog']>[1]
  browser_profile_get: { profileId: string }
  browser_profile_create: ({ intent?: 'create' } & Parameters<Profiles['create']>[1]) | ({ intent: 'add_existing' } & Parameters<Profiles['addExisting']>[1])
  browser_profile_update: ({ intent: 'metadata' } & Parameters<Profiles['update']>[1])
    | ({ intent: 'local_override' } & Parameters<Profiles['setLocalOverride']>[1])
    | ({ intent: 'confirm_login' } & Parameters<Profiles['confirmLogin']>[1])
    | ({ intent: 'check_origin' } & Parameters<Profiles['checkOrigin']>[1])
  browser_profile_remove: Parameters<Profiles['remove']>[1]
  browser_profiles_sync: Parameters<typeof admitBrowserProfileSync>[2]
  browser_profile_sync_get: Parameters<typeof readBrowserProfileSync>[2]
  browser_session_open: { intent: 'prepare'; request: OptionalCommand<Parameters<BrowserBroker['prepare']>[0]> }
    | { intent: 'setup'; profileId: string; computerId: string; commandId?: string }
    | ({ intent: 'native_window' } & OptionalCommand<Parameters<Sessions['openLocal']>[1]>)
    | { intent: 'reconnect'; sessionId: string; commandId?: string }
  browser_sessions_list: Parameters<Sessions['list']>[1]
  browser_session_get: { sessionId: string }
  browser_session_close: OptionalCommand<Parameters<Sessions['close']>[1]>
  browser_tabs_list: { sessionId: string }
  browser_tab_create: OptionalCommand<Parameters<Sessions['tab']>[2]>
  browser_tab_select: OptionalCommand<Parameters<Sessions['tab']>[2]>
  browser_tab_close: OptionalCommand<Parameters<Sessions['tab']>[2]>
  browser_state_read: Parameters<Sessions['observe']>[1]
  browser_screenshot: Parameters<Sessions['observe']>[1]
  browser_action: OptionalCommand<Parameters<Sessions['perform']>[1]>
  browser_view_open: Parameters<Sessions['viewOpen']>[1]
  browser_view_read: Parameters<Sessions['viewRead']>[1]
  browser_view_close: { viewId: string }
  browser_control_acquire: OptionalCommand<Parameters<Sessions['acquire']>[1]>
  browser_control_release: OptionalCommand<Parameters<Sessions['release']>[1]> & { intent?: 'resume' | 'pause' }
  browser_input: Parameters<Sessions['input']>[1]
}

/** C0 supplies canonical public schemas/codecs. These typed private service bindings define no wire schemas. */
export type BrowserCanonicalCodecs = { [Name in BrowserOperationName]: {
  inputSchema: StandardSchemaWithJSON
  outputSchema?: StandardSchemaWithJSON
  decodeHttp(request: { params: unknown; query: unknown; body: unknown; method?: string; url?: string }): BrowserOperationInputs[Name]
  decodeMcp(value: unknown): BrowserOperationInputs[Name]
  encode(value: unknown): unknown
} }
export type BrowserOperationHandlers = { [Name in BrowserOperationName]: (principal: ManagementPrincipal, input: BrowserOperationInputs[Name]) => Promise<unknown> }

export function createBrowserOperationHandlers(profiles: Profiles, sessions: Sessions): BrowserOperationHandlers {
  const command = <T extends { commandId?: string }>(input: T) => ({ ...input, commandId: input.commandId ?? randomUUID() })
  return {
    browser_profiles_list: (p, i) => profiles.catalog(p, i),
    browser_profile_get: (p, i) => profiles.get(p, i.profileId),
    browser_profile_create: (p, i) => i.intent === 'add_existing' ? profiles.addExisting(p, i) : profiles.create(p, i),
    browser_profile_update: (p, i) => i.intent === 'local_override' ? profiles.setLocalOverride(p, i)
      : i.intent === 'confirm_login' ? profiles.confirmLogin(p, i) : i.intent === 'check_origin' ? profiles.checkOrigin(p, i) : profiles.update(p, i),
    browser_profile_remove: (p, i) => profiles.remove(p, i),
    browser_profiles_sync: (p, i) => admitBrowserProfileSync(profiles, p, i),
    browser_profile_sync_get: (p, i) => readBrowserProfileSync(profiles, p, i),
    browser_session_open: (p, i) => i.intent === 'prepare' ? sessions.open(p, command(i.request))
      : i.intent === 'native_window' ? sessions.openLocal(p, command(i)) : i.intent === 'reconnect'
        ? sessions.reconnect(p, command(i)) : sessions.open(p, command(i)),
    browser_sessions_list: (p, i) => sessions.list(p, i),
    browser_session_get: (p, i) => sessions.get(p, i.sessionId),
    browser_session_close: (p, i) => sessions.close(p, command(i)),
    browser_tabs_list: (p, i) => sessions.tabs(p, i.sessionId),
    browser_tab_create: (p, i) => sessions.tab(p, 'create', command(i)),
    browser_tab_select: (p, i) => sessions.tab(p, 'select', command(i)),
    browser_tab_close: (p, i) => sessions.tab(p, 'close', command(i)),
    browser_state_read: (p, i) => sessions.observe(p, i),
    browser_screenshot: (p, i) => sessions.screenshot(p, i),
    browser_action: (p, i) => sessions.perform(p, command(i)),
    browser_view_open: (p, i) => sessions.viewOpen(p, i),
    browser_view_read: (p, i) => sessions.viewRead(p, i),
    browser_view_close: (p, i) => sessions.viewClose(p, i.viewId),
    browser_control_acquire: (p, i) => sessions.acquire(p, command(i)),
    browser_control_release: (p, i) => i.intent === 'pause' ? sessions.pause(p, command(i)) : sessions.release(p, command(i)),
    browser_input: (p, i) => sessions.input(p, i),
  }
}

export function bindBrowserOperation<Name extends BrowserOperationName>(name: Name, handlers: BrowserOperationHandlers, codecs: BrowserCanonicalCodecs) {
  return {
    async http(principal: ManagementPrincipal, request: { params: unknown; query: unknown; body: unknown }, rawBytes = false) {
      const value = await handlers[name](principal, codecs[name].decodeHttp(request))
      return rawBytes && value instanceof Uint8Array ? value : codecs[name].encode(value)
    },
    async mcp(principal: ManagementPrincipal, input: unknown) {
      return codecs[name].encode(await handlers[name](principal, codecs[name].decodeMcp(input)))
    },
  }
}
