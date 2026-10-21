import type pg from 'pg'
import { z } from 'zod'
import type { WorkflowChatTarget } from './workflowControlTypes.js'
import { workflowTargetRunId } from './workflowControlRecords.js'

const notificationSchema = z.object({ schema: z.string(), runId: z.string(),
  kind: z.enum(['execution', 'consultation']).optional(), scopeId: z.string().optional() })
type Watch = { target: WorkflowChatTarget; changed(): void; failed(error: Error): void }
type Session = { ready: Promise<void>; client?: pg.PoolClient; schema?: string; watches: Set<Watch>;
  notification(message: pg.Notification): void; error(error: Error): void }

/** One connection serves the visible chats; PostgreSQL publishes only after commit. */
export class WorkflowChatNotifications {
  private session: Session | undefined
  constructor(private readonly pool: pg.Pool) {}

  subscribe(watch: Watch) {
    const session = this.session ?? this.open()
    session.watches.add(watch)
    return { ready: session.ready, close: () => {
      session.watches.delete(watch)
      if (!session.watches.size) this.dispose(session)
    } }
  }

  private open(): Session {
    const session: Session = { ready: Promise.resolve(), watches: new Set(),
      notification: message => {
        if (message.channel !== 'workflow_chat_changed' || !message.payload) return
        try {
          const change = notificationSchema.parse(JSON.parse(message.payload))
          if (change.schema !== session.schema) return
          for (const watch of session.watches) {
            const target = watch.target
            if (workflowTargetRunId(target) !== change.runId) continue
            const kind = target.kind === 'workflow_execution' ? 'execution' : 'consultation'
            const scopeId = target.kind === 'workflow_execution' ? target.execution.executionId : target.waitingActivationId
            if (change.kind && (kind !== change.kind || scopeId !== change.scopeId)) continue
            watch.changed()
          }
        } catch (error) { session.error(error instanceof Error ? error : new Error('Invalid chat notification')) }
      },
      error: error => {
        const watches = [...session.watches]
        this.dispose(session)
        for (const watch of watches) watch.failed(error)
      },
    }
    this.session = session
    session.ready = this.pool.connect().then(async client => {
      session.client = client
      client.on('error', session.error)
      client.on('notification', session.notification)
      session.schema = (await client.query<{ schema: string }>('select current_schema() as schema')).rows[0]!.schema
      await client.query('LISTEN workflow_chat_changed')
      if (this.session !== session) this.dispose(session)
    }).catch(error => {
      session.error(error instanceof Error ? error : new Error('Chat subscription failed'))
      throw error
    })
    return session
  }

  private dispose(session: Session) {
    if (this.session === session) this.session = undefined
    const client = session.client
    if (!client) return
    delete session.client
    client.removeListener('notification', session.notification)
    client.removeListener('error', session.error)
    client.release(true)
  }
}
