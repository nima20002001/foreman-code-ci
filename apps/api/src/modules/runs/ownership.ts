import { beginRuntimeTiming } from '../../infrastructure/runtimeTiming.js'
import pg from 'pg'

import { ExclusiveGraphConnection, type GraphSqlClient } from '../run-graph/connection.js'
import { memoizeNativeRead } from '../run-graph/nativeBatch.js'
import { DomainError } from '../errors.js'
import { ignoreError } from '../diagnostics/ignoredError.js'

/**
 * PostgreSQL, not an API process's maps, arbitrates execution ownership.
 * A dedicated session avoids exhausting the application's query pool while
 * runs hold locks. Losing the session cancels work; interrupted work is never
 * automatically replayed, because a native tool may already have side effects.
 */
export class RunOwnership {
  private lost = false
  private released = false
  private releaseRequested = false
  private readonly retained = new Set<{ onLost(): void }>()
  private closing: Promise<void> | undefined

  private graphConnection: ExclusiveGraphConnection | undefined
  private queryClient: pg.Client | undefined
  private generation: string | undefined

  private constructor(private readonly rawClient: pg.Client, readonly runId: string, private readonly onLost: () => void) {}

  /** Existing native callers share the same serialized port after v2 adoption. */
  get client(): pg.Client { return this.queryClient ?? this.rawClient }

  get checkpointGeneration(): string {
    this.assertOwned()
    if (!this.generation) throw new DomainError('RUN_OWNERSHIP_LOST', 'The checkpoint owner is unavailable.', 409)
    return this.generation
  }

  /** Adopt only before dispatch. No second pool connection can publish on this owner's behalf. */
  oneShotConnection(): ExclusiveGraphConnection {
    this.assertOwned()
    if (!this.graphConnection) {
      const connection = new ExclusiveGraphConnection(this.rawClient, () => this.assertOwned(), new Map())
      this.graphConnection = connection
      this.queryClient = new Proxy(this.rawClient, {
        get: (target, property) => {
          if (property === 'query') return connection.query.bind(connection)
          // Connection lifetime is exclusively RunOwnership's responsibility.
          if (property === 'end' || property === 'connect') {
            return () => { throw new DomainError('RUN_OWNERSHIP_CONNECTION_PRIVATE', 'Use RunOwnership to manage its connection.', 409) }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
    return this.graphConnection
  }

  /** PostgreSQL session identity and actual held lock, not a cached/echoed lease. */
  async readOneShotFence(sql: GraphSqlClient): Promise<{ ownerId: string; fence: string }> {
    this.assertOwned()
    // Inside a native batch the session advisory lock is read once at start and once at COMMIT.
    return memoizeNativeRead(sql, `fence:${this.runId}`, () => this.readHeldFence(sql))
  }

  private async readHeldFence(sql: GraphSqlClient): Promise<{ ownerId: string; fence: string }> {
    const result = await sql.query<{ owner_id: string; fence: string }>(
      `select pg_backend_pid()::text as owner_id,
              (extract(epoch from a.backend_start)*1000000)::bigint::text as fence
       from pg_stat_get_activity(pg_backend_pid()) a
       where a.pid=pg_backend_pid() and exists (
         select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
         and l.classid=810002::oid and l.objid=(hashtext($1)::bigint & 4294967295)::oid
         and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted
       )`, [this.runId],
    )
    const row = result.rows[0]
    if (!row) throw new DomainError('RUN_OWNERSHIP_LOST', 'The current session no longer owns this Run.', 409)
    return { ownerId: row.owner_id, fence: row.fence }
  }

  static async acquire(pool: pg.Pool, runId: string, onLost: () => void): Promise<RunOwnership | undefined> {
    const client = new pg.Client({ ...pool.options, application_name: 'graphql-run-owner' })
    const owner = new RunOwnership(client, runId, onLost)
    client.on('error', owner.handleLoss)
    client.on('end', owner.handleLoss)
    try {
      await client.connect()
      const result = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock($1, hashtext($2)) as acquired',
        [810_002, runId],
      )
      if (result.rows[0]?.acquired) {
        const row = (await client.query<{ generation: string }>(`insert into run_checkpoint_owners
          (run_id,generation,owner_pid,owner_started_at)
          select $1,1,pg_backend_pid(),backend_start from pg_stat_activity where pid=pg_backend_pid()
          on conflict(run_id) do update set generation=run_checkpoint_owners.generation+1,
            owner_pid=excluded.owner_pid,owner_started_at=excluded.owner_started_at
          returning generation::text`, [runId])).rows[0]
        if (!row) throw new DomainError('RUN_OWNERSHIP_LOST', 'The checkpoint owner could not be recorded.', 409)
        owner.generation = row.generation
        return owner
      }
      await owner.release()
      return undefined
    } catch (error) {
      await owner.release()
      throw error
    }
  }

  private readonly handleLoss = () => {
    if (this.released || this.lost) return
    this.lost = true
    this.onLost()
    for (const retained of this.retained) retained.onLost()
  }

  assertOwned(): void {
    if (this.lost || this.released) {
      throw new DomainError('RUN_OWNERSHIP_LOST', 'The database execution owner disconnected. The run requires reconciliation.', 409)
    }
  }

  /** An admitted native review keeps this same database session until its own work drains. */
  retain(onLost: () => void): () => Promise<void> {
    this.assertOwned()
    const retained = { onLost }
    this.retained.add(retained)
    let active = true
    return async () => {
      if (!active) return
      active = false
      this.retained.delete(retained)
      if (this.releaseRequested && this.retained.size === 0) await this.close()
    }
  }

  async release(): Promise<void> {
    this.releaseRequested = true
    if (this.retained.size === 0) await this.close()
  }

  private close(): Promise<void> {
    if (this.closing) return this.closing
    this.released = true
    const finished = beginRuntimeTiming('db', 'owner.release', { runId: this.runId })
    // Closing, rather than returning this session to a pool, always releases
    // its advisory lock, including after a failed query or lost connection.
    this.closing = (async () => {
      try {
        await this.graphConnection?.close()
      } finally {
        await this.rawClient.end().catch(ignoreError('engine', 'close run ownership client', { runId: this.runId }))
        this.rawClient.removeListener('error', this.handleLoss)
        this.rawClient.removeListener('end', this.handleLoss)
        finished()
      }
    })()
    return this.closing
  }
}
