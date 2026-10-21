import type pg from 'pg'
import type { MemoryBoardDependencies } from './types.js'

interface Subscription {
  boardId: string
  changed(): void
  disconnected(): void
}
interface ListeningSession {
  ready: Promise<void>
  subscribers: Set<Subscription>
  client: pg.PoolClient | undefined
  closed: boolean
  notification(message: pg.Notification): void
  lost(): void
}

class MemoryBoardNotifications {
  private session: ListeningSession | undefined

  constructor(private readonly pool: pg.Pool) {}

  async listen(boardId: string, changed: () => void, disconnected: () => void): Promise<() => void> {
    const session = this.session ?? this.open()
    const subscription = { boardId, changed, disconnected }
    session.subscribers.add(subscription)
    await session.ready
    if (session.closed) throw new Error('The memory notification connection closed during subscription.')
    return () => {
      session.subscribers.delete(subscription)
      if (!session.subscribers.size) this.close(session)
    }
  }

  private open(): ListeningSession {
    const session: ListeningSession = {
      ready: Promise.resolve(), subscribers: new Set(), client: undefined, closed: false,
      notification: message => {
        if (session.closed || message.channel !== 'memory_board_changes') return
        for (const subscription of session.subscribers) {
          if (subscription.boardId === message.payload) subscription.changed()
        }
      },
      lost: () => this.disconnect(session),
    }
    this.session = session
    session.ready = this.connect(session)
    return session
  }

  private async connect(session: ListeningSession): Promise<void> {
    try {
      const client = await this.pool.connect()
      session.client = client
      client.on('notification', session.notification)
      client.on('error', session.lost)
      client.on('end', session.lost)
      await client.query('listen memory_board_changes')
    } catch (error) {
      this.disconnect(session)
      throw error
    }
  }

  private disconnect(session: ListeningSession): void {
    if (session.closed) return
    const subscriptions = [...session.subscribers]
    this.close(session)
    for (const subscription of subscriptions) subscription.disconnected()
  }

  private close(session: ListeningSession): void {
    if (session.closed) return
    session.closed = true
    if (this.session === session) this.session = undefined
    session.subscribers.clear()
    const client = session.client
    session.client = undefined
    if (!client) return
    client.removeListener('notification', session.notification)
    client.removeListener('error', session.lost)
    client.removeListener('end', session.lost)
    // Destroy the connection so LISTEN cannot leak into a pooled query session.
    client.release(true)
  }
}

const listeners = new WeakMap<pg.Pool, MemoryBoardNotifications>()

/** Visible boards share one LISTEN connection per pool, released with the last subscription. */
export function postgresMemoryBoardListener(pool: pg.Pool): MemoryBoardDependencies['listen'] {
  let listener = listeners.get(pool)
  if (!listener) {
    listener = new MemoryBoardNotifications(pool)
    listeners.set(pool, listener)
  }
  return listener.listen.bind(listener)
}
