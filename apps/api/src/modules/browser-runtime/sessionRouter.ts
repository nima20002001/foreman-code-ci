import type pg from 'pg'
import { BrowserSessionSchema } from '@foreman-code/contracts/browser-sessions'
import { DomainError } from '../errors.js'
import type { BrowserPairingAuthority, BrowserInstallationBinding } from '../browser-profiles/keys.js'
import type { BrowserSessionService, BrowserSessionAuthority, BrowserSessionPort, BrowserSessionListInput } from './service.js'
import type { AgentSubject, BrowserSession } from './types.js'
import type { BrowserMediaSource } from './mediaSocket.js'

type Method = keyof BrowserSessionPort<unknown>
type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : never
export interface BrowserSessionTransport<Principal> {
  /** The paired private command validates the current installation and invokes B's host service. */
  invoke<Name extends Method>(binding: BrowserInstallationBinding, method: Name, principal: Principal,
    args: Tail<Parameters<BrowserSessionPort<Principal>[Name]>>): Promise<Awaited<ReturnType<BrowserSessionPort<Principal>[Name]>>>
}
export interface BrowserSessionLocations {
  session(id: string): Promise<{ session: BrowserSession; installationId: string } | undefined>
  save(session: BrowserSession, installationId: string): Promise<void>
  view(viewId: string): Promise<string | undefined>
  saveView(viewId: string, sessionId: string): Promise<void>
}
export function createBrowserSessionLocations(pool: pg.Pool): BrowserSessionLocations {
  return {
    async session(id) {
      const row = (await pool.query<{ session: unknown; installation_id: string }>('select session,installation_id from browser_session_locations where session_id=$1', [id])).rows[0]
      return row ? { session: BrowserSessionSchema.parse(row.session), installationId: row.installation_id } : undefined
    },
    async save(session, installationId) {
      await pool.query(`insert into browser_session_locations(session_id,computer_id,installation_id,session) values($1,$2,$3,$4)
        on conflict(session_id) do update set session=excluded.session where browser_session_locations.installation_id=excluded.installation_id`,
      [session.id, session.computerId, installationId, BrowserSessionSchema.parse(session)])
    },
    async view(viewId) { return (await pool.query<{ session_id: string }>('select session_id from browser_view_locations where view_id=$1', [viewId])).rows[0]?.session_id },
    async saveView(viewId, sessionId) { await pool.query('insert into browser_view_locations(view_id,session_id) values($1,$2) on conflict(view_id) do nothing', [viewId, sessionId]) },
  }
}

export interface BrowserSessionRouterOptions<Principal> {
  localComputerId: string; local: BrowserSessionService<Principal>; locations: BrowserSessionLocations
  pairing: BrowserPairingAuthority; transport: BrowserSessionTransport<Principal>; authority: BrowserSessionAuthority<Principal>
  computers(principal: Principal): Promise<readonly string[]>
  subjectComputer(principal: Principal, subject: AgentSubject): Promise<string>
  media(binding: BrowserInstallationBinding): BrowserMediaSource<Principal>
}

/** Main's concrete selected-computer routing; D provides its existing authority and paired transport only. */
export function createBrowserSessionRouter<Principal>(options: BrowserSessionRouterOptions<Principal>): BrowserSessionPort<Principal> {
  const call = async <Name extends Method>(computerId: string, name: Name, principal: Principal,
    args: Tail<Parameters<BrowserSessionPort<Principal>[Name]>>, installationId?: string): Promise<Awaited<ReturnType<BrowserSessionPort<Principal>[Name]>>> => {
    const binding = await options.pairing.current(computerId)
    await options.pairing.assertCurrent(binding)
    if (installationId && binding.installationId !== installationId) throw new DomainError('BROWSER_PAIRING_CHANGED', 'This session belongs to the previous computer installation.', 409)
    let result: Awaited<ReturnType<BrowserSessionPort<Principal>[Name]>>
    if (computerId === options.localComputerId) {
      const invoke = options.local[name] as (principal: Principal,
        ...values: Tail<Parameters<BrowserSessionPort<Principal>[Name]>>) => ReturnType<BrowserSessionPort<Principal>[Name]>
      result = await invoke.call(options.local, principal, ...args)
    } else {
      result = await options.transport.invoke(binding, name, principal, args)
    }
    await options.pairing.assertCurrent(binding)
    if (result && typeof result === 'object') {
      const value = result as Record<string, unknown>
      const sessions = Array.isArray(value.sessions) ? value.sessions : value.session ? [value.session] : []
      for (const candidate of sessions) {
        const session = BrowserSessionSchema.parse(candidate)
        if (session.computerId !== computerId) throw new DomainError('BROWSER_COMPUTER_SCOPE', 'The remote session belongs to another computer.', 403)
        await options.locations.save(session, binding.installationId)
      }
    }
    return result as Awaited<ReturnType<BrowserSessionPort<Principal>[Name]>>
  }
  const locate = async (principal: Principal, sessionId: string, mutate: boolean) => {
    const found = await options.locations.session(sessionId)
    if (!found) throw new DomainError('BROWSER_NOT_FOUND', 'The browser session is unavailable. Refresh its session list.', 404)
    await options.authority.session(principal, found.session, mutate)
    return found
  }
  const sessionCall = async <Name extends Method>(name: Name, principal: Principal, sessionId: string, mutate: boolean,
    args: Tail<Parameters<BrowserSessionPort<Principal>[Name]>>): Promise<Awaited<ReturnType<BrowserSessionPort<Principal>[Name]>>> => {
    const found = await locate(principal, sessionId, mutate)
    return call(found.session.computerId, name, principal, args, found.installationId)
  }
  const viewLocation = async (principal: Principal, viewId: string) => {
    const id = await options.locations.view(viewId)
    if (!id) throw new DomainError('BROWSER_VIEW_CLOSED', 'This browser view is unavailable.', 404)
    return { id, ...await locate(principal, id, false) }
  }
  return {
    async open(principal, input) {
      if ('subject' in input) await options.authority.subject(principal, input.subject, true)
      else await options.authority.setup(principal, input.profileId, input.computerId, true)
      return call(input.computerId, 'open', principal, [input])
    },
    async list(principal, input: BrowserSessionListInput = {}) {
      if (input.subject) await options.authority.subject(principal, input.subject, false)
      const computers = input.computerId ? [input.computerId] : input.subject
        ? [await options.subjectComputer(principal, input.subject)] : [...await options.computers(principal)].sort()
      let current = 0, cursor: string | undefined
      if (input.cursor) {
        const value: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || value[1] !== null && typeof value[1] !== 'string') throw new DomainError('CURSOR_INVALID', 'Invalid browser session cursor.', 400)
        current = computers.indexOf(value[0]); cursor = value[1] ?? undefined
        if (current < 0) throw new DomainError('CURSOR_INVALID', 'The browser computer set changed. Refresh the session list.', 409)
      }
      const computer = computers[current]
      if (!computer) return { sessions: [], nextCursor: null }
      const page = await call(computer, 'list', principal, [{ ...input, computerId: computer, cursor }])
      const next = page.nextCursor ? [computer, page.nextCursor] : computers[current + 1] ? [computers[current + 1], null] : null
      return { sessions: page.sessions, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null }
    },
    authorizeUpload: (p, id, fileId) => sessionCall('authorizeUpload', p, id, true, [id, fileId]),
    get: (p, id) => sessionCall('get', p, id, false, [id]),
    reconnect: (p, i) => sessionCall('reconnect', p, i.sessionId, true, [i]),
    close: (p, i) => sessionCall('close', p, i.sessionId, true, [i]),
    action: (p, i) => sessionCall('action', p, i.sessionId, true, [i]),
    perform: (p, i) => sessionCall('perform', p, i.sessionId, i.intent !== 'file' || !['read', 'metadata'].includes(i.phase), [i]),
    observe: (p, i) => sessionCall('observe', p, i.sessionId, false, [i]),
    screenshot: (p, i) => sessionCall('screenshot', p, i.sessionId, false, [i]),
    tabs: (p, id) => sessionCall('tabs', p, id, false, [id]),
    tab: (p, operation, i) => sessionCall('tab', p, i.sessionId, true, [operation, i]),
    acquire: (p, i) => sessionCall('acquire', p, i.sessionId, true, [i]),
    release: (p, i) => sessionCall('release', p, i.sessionId, true, [i]),
    pause: (p, i) => sessionCall('pause', p, i.sessionId, true, [i]),
    input: (p, i) => sessionCall('input', p, i.sessionId, true, [i]),
    openLocal: (p, i) => sessionCall('openLocal', p, i.sessionId, true, [i]),
    async viewOpen(p, i) {
      const view = await sessionCall('viewOpen', p, i.sessionId, false, [i])
      await options.locations.saveView(view.id, i.sessionId); return view
    },
    async viewRead(p, i) {
      const found = await viewLocation(p, i.viewId), binding = await options.pairing.current(found.session.computerId)
      if (binding.installationId !== found.installationId) throw new DomainError('BROWSER_PAIRING_CHANGED', 'This view belongs to the previous computer installation.', 409)
      const source = await options.media(binding).open(p, found.id, i.viewId, () => { /* A bounded MCP read asks for the current frame only. */ })
      try { const { view, frame } = await source.read(i.after ?? 0); return { view, frame } } finally { await source.close(false) }
    },
    async viewClose(p, viewId) {
      const found = await viewLocation(p, viewId)
      return call(found.session.computerId, 'viewClose', p, [viewId], found.installationId)
    },
  }
}
