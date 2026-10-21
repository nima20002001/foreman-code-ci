import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { ApprovalPostgresSaver } from './approvalCheckpointSaver.js'

import { createPool, queryForReadiness, type DatabaseOptions } from './pool.js'

export interface CheckpointStore {
  readonly saver: BaseCheckpointSaver
  setup(): Promise<void>
  ping(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export function createCheckpointStore(
  connectionString: string,
  schema: string,
  options: Omit<DatabaseOptions, 'connectionString'> = {
    maxConnections: 10,
    connectionTimeoutMs: 5000,
  },
): CheckpointStore {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error('Checkpoint schema must be a lowercase PostgreSQL identifier')
  }
  const pool = createPool({ ...options, connectionString }, 'graphql-checkpoints')
  const saver = new ApprovalPostgresSaver(pool, undefined, { schema })

  return {
    saver,
    async setup() {
      const migrationPool = createPool({ ...options, connectionString, maxConnections: 1,
        queryTimeoutMs: 60_000, lockTimeoutMs: 5_000 }, 'graphql-checkpoint-migrations')
      try {
        await new ApprovalPostgresSaver(migrationPool, undefined, { schema }).setup()
      } finally {
        await migrationPool.end()
      }
    },
    async ping(signal) {
      // Check the actual checkpoint tables using the saver's own pool, but keep
      // ownership of the probe's client so a deadline can destroy it safely.
      await queryForReadiness(pool, `
        select 1 from "${schema}".checkpoints
        left join "${schema}".checkpoint_blobs on false
        left join "${schema}".checkpoint_writes on false
        limit 1
      `, signal)
    },
    async close() {
      await saver.end()
    },
  }
}
