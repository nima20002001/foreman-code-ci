import type pg from 'pg'
import { DomainError } from '../errors.js'

export interface CiTicketChange { workspaceId: string; ticketId: string; groupId: string }
interface Watch {
  match(change: CiTicketChange): boolean
  version: number
  failure?: unknown
  wake?: (() => void) | undefined
}
interface ListeningSession {
  ready: Promise<void>
  watches: Set<Watch>
  client: pg.PoolClient | undefined
  notification: (message: pg.Notification) => void
  error: (error: Error) => void
}
/** Counts matching changes; a waiter reads the version before its read and waits only for changes after it. */
export interface CiTicketWatch {
  ready: Promise<void>
  version(): number
  changedSince(version: number, ms: number): Promise<void>
  close(): void
}

/** Concurrent waits share one LISTEN connection; PostgreSQL sends changes after commit. */
export class CiTicketChanges {
  private session: ListeningSession | undefined

  constructor(private readonly pool: pg.Pool) {}

  private fail(session: ListeningSession, error: unknown) {
    for (const watch of session.watches) {
      watch.failure = error
      watch.wake?.()
    }
  }

  private open(): ListeningSession {
    const session: ListeningSession = {
      ready: Promise.resolve(), watches: new Set(), client: undefined,
      notification: message => {
        if (message.channel !== 'ci_ticket_changed' || !message.payload) return
        const change = JSON.parse(message.payload) as CiTicketChange
        for (const watch of session.watches) {
          if (!watch.match(change)) continue
          watch.version++
          watch.wake?.()
        }
      },
      error: error => {
        this.fail(session, error)
        this.dispose(session)
      },
    }
    this.session = session
    session.ready = this.pool.connect().then(async client => {
      client.on('error', session.error)
      client.on('notification', session.notification)
      try {
        await client.query('LISTEN ci_ticket_changed')
      } catch (error) {
        client.removeListener('error', session.error)
        client.removeListener('notification', session.notification)
        client.release(true)
        throw error
      }
      session.client = client
      if (this.session !== session) this.dispose(session)
    }).catch(error => {
      this.fail(session, error)
      this.dispose(session)
      throw error
    })
    return session
  }

  subscribe(match: (change: CiTicketChange) => boolean, signal?: AbortSignal): CiTicketWatch {
    const session = this.session ?? this.open()
    const watch: Watch = { match, version: 0 }
    session.watches.add(watch)
    const cancelled = () => new DomainError('MCP_REQUEST_CANCELLED', 'The CI wait was canceled.', 409)
    return {
      ready: session.ready,
      version: () => watch.version,
      changedSince: (version, ms) => new Promise<void>((resolve, reject) => {
        if (watch.failure !== undefined) return reject(watch.failure)
        if (watch.version !== version) return resolve()
        if (signal?.aborted) return reject(cancelled())
        const finish = (error?: unknown) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          watch.wake = undefined
          if (error !== undefined) reject(error)
          else resolve()
        }
        const onAbort = () => finish(cancelled())
        const timer = setTimeout(() => finish(), ms)
        signal?.addEventListener('abort', onAbort, { once: true })
        watch.wake = () => finish(watch.failure)
      }),
      close: () => {
        session.watches.delete(watch)
        if (!session.watches.size) this.dispose(session)
      },
    }
  }

  private dispose(session: ListeningSession) {
    if (this.session === session) this.session = undefined
    const client = session.client
    if (!client) return
    session.client = undefined
    client.removeListener('notification', session.notification)
    client.removeListener('error', session.error)
    // Destroy the connection so its LISTEN registration cannot leak into a pooled query session.
    client.release(true)
  }

  close() {
    const session = this.session
    if (!session) return
    this.fail(session, new DomainError('CI_SERVICE_CLOSED', 'The CI service is closing.', 503))
    this.dispose(session)
  }
}
