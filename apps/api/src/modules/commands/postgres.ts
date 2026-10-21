import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../../infrastructure/transaction.js'
export { commandInputHash } from '@foreman-code/contracts/command-identity-node'

import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import pg from 'pg'
import { setTimeout as delay } from 'node:timers/promises'

import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { componentLogger } from '../diagnostics/logger.js'
import { commandIdentity, commandReceiptPrincipals } from './identity.js'
import { expiredCommandResult } from './receiptRetention.js'
export { pruneCompletedCommandReceipts } from './receiptRetention.js'

function commitWasRejected(error: unknown): boolean {
  if (!(error instanceof pg.DatabaseError) || !error.code) return false
  // SQLSTATE is not localized. This is used only after a successful rollback;
  // connection failures and unknown completion still leave COMMIT ambiguous.
  return !error.code.startsWith('08') && error.code !== '40003'
}

/** Wait outside SQL transactions without a blocking statement that can time out. */
async function acquireSessionLock(client: pg.PoolClient, key: string): Promise<void> {
  // Source preparation can take five minutes; queued captures need their own wait budget.
  const deadline = performance.now() + 600_000
  let backoffMs = 50
  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as locked', [key])
    if (result.rows[0]!.locked) return
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) {
      throw new DomainError('COMMAND_LOCK_TIMEOUT',
        'Another command is still using this resource. Retry the original command.', 503,
        { retryable: true, newCommandRequired: false })
    }
    const waitMs = Math.min(backoffMs * (0.5 + Math.random() * 0.5), remainingMs)
    await delay(waitMs)
    backoffMs = Math.min(1000, backoffMs * 2)
  }
}

function commandDatabaseFailure(error: unknown): unknown {
  if (error instanceof DomainError) return error
  const code = error instanceof pg.DatabaseError ? error.code : undefined
  const readTimeout = error instanceof Error && error.message === 'Query read timeout'
  if (code !== '57014' && code !== '55P03' && !readTimeout) return error
  const failure = new DomainError('COMMAND_DATABASE_TIMEOUT',
    'The database command exceeded its deadline. Retry the original command.', 503,
    { retryable: true, newCommandRequired: false, ...(code ? { sqlState: code } : {}) })
  failure.cause = error
  return failure
}

const lifecyclePools = new WeakMap<pg.Pool, pg.Pool>()

/** Commands that own a session for their whole lifecycle lease it from one long-lived pool beside the application
 * pool, so each command keeps its own connection without connecting and authenticating anew. It closes with that pool. */
function lifecyclePool(pool: pg.Pool): pg.Pool {
  const existing = lifecyclePools.get(pool)
  if (existing) return existing
  const lifecycle = new pg.Pool({ ...pool.options, min: 0, max: Math.max(pool.options.max ?? 10, 10),
    application_name: 'graphql-lifecycle-command' })
  const sessions = new Set<Promise<void>>()
  lifecycle.on('connect', client => {
    // Ending a pool resolves before its sockets close; the application pool's end waits for them.
    const closed: Promise<void> = new Promise(resolve => client.once('end', () => {
      sessions.delete(closed)
      resolve()
    }))
    sessions.add(closed)
  })
  lifecycle.on('error', error => {
    componentLogger('db').error({ err: error, pool: 'graphql-lifecycle-command' }, 'idle PostgreSQL connection failed')
  })
  const endApplicationPool = pool.end.bind(pool)
  pool.end = (async (callback?: () => void) => {
    await Promise.all([endApplicationPool(), lifecycle.end().then(() => Promise.all(sessions))])
    callback?.()
  }) as pg.Pool['end']
  lifecyclePools.set(pool, lifecycle)
  return lifecycle
}

interface PreparedMutation {
  /** Idempotent preparation may invoke commands that need the same bounded pools. */
  releaseDuringPreparation?: true
  /** Serialize only the prepared database mutation, leaving preparation concurrent. */
  resourceLock: string
  /** Retry preparation when concurrent mutations changed its database inputs. */
  validate(client: pg.PoolClient): Promise<boolean>
}

/** Preparation is retried only after its database snapshot changes. */
class PreparationRequired extends Error {}

interface CommandInput<T> {
  principal: ManagementPrincipal
  source: 'http' | 'mcp' | 'device'
  operation: string
  commandId?: string | undefined
  targetKey: string
  payload: unknown
  /** Serialize local external effects through transaction rollback and compensation. */
  resourceLock?: string
  perform(client: pg.PoolClient): Promise<T>
  /** Revalidate live authority under the command lock, including receipt reads.
   * Transactional callers may retain their authority row locks through COMMIT. */
  authorize?(client: pg.PoolClient): Promise<void>
  /** Compensate external effects only after a confirmed rollback, using the idle connection. */
  afterRollback?(client: pg.PoolClient): Promise<void>
  /** Lifecycle callbacks may await runtime cleanup that needs the application pool. */
  dedicatedConnection?: true
  /** Prepare immutable bytes or installed metadata outside SQL.
   * Mutations with releaseDuringPreparation recheck their snapshot after releasing ownership.
   * Admission and its receipt share one transaction. */
  prepare?(pool: pg.Pool): Promise<void>
  preparedMutation?: PreparedMutation
  /** Explicit compatibility boundary for historical receipts, never new commands. */
  replayResult?(result: unknown): T
  /** Resume an unfinished external operation under its original command lock. */
  shouldResumeReceipt?(client: pg.PoolClient): Promise<boolean>
}

export class PostgresCommandCoordinator {
  constructor(private readonly pool: pg.Pool) {}

  async execute<T>(input: CommandInput<T>): Promise<{ value: T; replayed: boolean }> {
    input = { ...input, commandId: input.commandId ?? randomUUID() }
    let prepared = false
    for (;;) {
      try {
        return await this.executeAttempt(input, { prepared })
      } catch (error) {
        if (!(error instanceof PreparationRequired)) throw error
      }
      try {
        await input.prepare!(this.pool)
        prepared = true
      } catch (error) {
        // An identical retry may commit while preparation runs without command ownership.
        return this.executeAttempt(input, { prepared: false, preparationFailure: { error } })
      }
    }
  }

  private async executeAttempt<T>(input: CommandInput<T>, options: {
    prepared: boolean
    preparationFailure?: { error: unknown }
  }): Promise<{ value: T; replayed: boolean }> {
    const commandId = input.commandId ?? randomUUID()
    const inputHash = commandInputHash(input.payload)
    const dedicatedConnection = input.dedicatedConnection || input.prepare !== undefined
    const client = await (dedicatedConnection ? lifecyclePool(this.pool) : this.pool).connect()
    let releaseError: Error | undefined
    let inTransaction = false
    let lifecycleLock = false
    let resourceLockRequested = false
    let committing = false
    let performing = false
    let commandLock = `command:${input.principal.id}:${input.operation}:${commandId}`
    const resourceLock = input.preparedMutation?.resourceLock ?? input.resourceLock
    try {
      const identity = await commandIdentity(client, input.principal)
      commandLock = `command:${identity.key}:${input.operation}:${commandId}`
      if (dedicatedConnection || input.preparedMutation) {
        // Track requests before acquisition: a lost reply may leave a session lock held.
        lifecycleLock = true
        await acquireSessionLock(client, commandLock)
      }
      if (input.resourceLock && lifecycleLock) {
        resourceLockRequested = true
        await acquireSessionLock(client, input.resourceLock)
      }
      await beginTransaction(client)
      inTransaction = true
      if (!lifecycleLock) {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [commandLock])
      }
      if (input.resourceLock && !resourceLockRequested) {
        resourceLockRequested = true
        await acquireSessionLock(client, input.resourceLock)
      }
      await input.authorize?.(client)
      const principals = await commandReceiptPrincipals(client, identity, input.principal.id)
      const existing = await client.query<{ principal_id: string; input_hash: string; target_key: string; result: unknown }>(
        `select principal_id, input_hash, target_key, result from management_command_receipts
         where principal_id = any($1::text[]) and operation = $2 and command_id = $3
         order by principal_id limit 1`,
        [principals, input.operation, commandId],
      )
      const receipt = existing.rows[0]
      let resumingReceipt = false
      if (receipt) {
        if (receipt.input_hash !== inputHash || receipt.target_key !== input.targetKey) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
        }
        resumingReceipt = await input.shouldResumeReceipt?.(client) ?? false
        if (!resumingReceipt) {
          const value = input.replayResult ? input.replayResult(receipt.result) : receipt.result as T
          committing = true
          await commitTransaction(client)
          committing = false
          inTransaction = false
          return { value, replayed: true }
        }
      }
      if (!receipt) {
        const expired = await client.query<{ command_id: string }>(`select details->>'commandId' as command_id
          from management_audit where principal_id=any($1::text[]) and action=$2
            and details->>'commandId'=$3 and outcome='succeeded' limit 1`,
        [principals, input.operation, commandId])
        if (expired.rows.length) throw expiredCommandResult()
      }
      if (options.preparationFailure) throw options.preparationFailure.error

      // A lifecycle callback can wait for runtime cleanup and database work.
      // Keep its command identity serialized by the session advisory lock, but
      // do not retain row locks while the idempotent callback runs.
      if (dedicatedConnection) {
        committing = true
        await commitTransaction(client)
        committing = false
        inTransaction = false
      }
      if (input.preparedMutation?.releaseDuringPreparation) {
        if (!options.prepared) throw new PreparationRequired()
        resourceLockRequested = true
        await acquireSessionLock(client, input.preparedMutation.resourceLock)
        await beginTransaction(client)
        inTransaction = true
        await input.authorize?.(client)
        if (!await input.preparedMutation.validate(client)) throw new PreparationRequired()
      } else if (input.prepare) {
        for (;;) {
          await input.prepare(this.pool)
          if (input.preparedMutation) {
            resourceLockRequested = true
            await acquireSessionLock(client, input.preparedMutation.resourceLock)
          }
          await beginTransaction(client)
          inTransaction = true
          await input.authorize?.(client)
          if (!input.preparedMutation || await input.preparedMutation.validate(client)) break
          await rollbackTransaction(client)
          inTransaction = false
          await client.query('select pg_advisory_unlock(hashtext($1))', [resourceLock])
          resourceLockRequested = false
        }
      }
      performing = true
      const value = await input.perform(client)
      if (dedicatedConnection && !input.prepare) {
        await beginTransaction(client)
        inTransaction = true
      }
      if (resumingReceipt) {
        await client.query(
          `update management_command_receipts set result=$4::jsonb
           where principal_id=$1 and operation=$2 and command_id=$3`,
          [receipt!.principal_id, input.operation, commandId, JSON.stringify(value)],
        )
      } else {
        await client.query(
          `insert into management_command_receipts
          (principal_id, operation, command_id, target_key, input_hash, result)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [input.principal.id, input.operation, commandId, input.targetKey, inputHash, JSON.stringify(value)],
        )
      }
      await client.query(
        `insert into management_audit (principal_id, source, action, target_key, outcome, details)
         values ($1, $2, $3, $4, 'succeeded', $5::jsonb)`,
        [input.principal.id, input.source, input.operation, input.targetKey, JSON.stringify({ commandId })],
      )
      committing = true
      await commitTransaction(client)
      inTransaction = false
      return { value, replayed: false }
    } catch (error) {
      let failure = commandDatabaseFailure(error)
      let cleanupFailed = false
      let rolledBack = false
      if (inTransaction) {
        try {
          await rollbackTransaction(client)
          inTransaction = false
          rolledBack = true
        } catch (rollbackError) {
          // A failed rollback leaves connection state unknown. Evict it, and
          // preserve the command error rather than replacing it with cleanup.
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Command rollback failed.')
        }
      }
      if (error instanceof PreparationRequired) {
        if (releaseError) throw releaseError
        throw error
      }
      if (performing && rolledBack && (!committing || commitWasRejected(error))) {
        try {
          await input.afterRollback?.(client)
        } catch (cleanupError) {
          cleanupFailed = true
          failure = new AggregateError([error, cleanupError], 'The command and rollback cleanup failed.')
          try {
            await rollbackTransaction(client)
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error('Command cleanup rollback failed.')
          }
        }
      }
      const commitUncertain = committing && !(rolledBack && commitWasRejected(error))
      let failureCode = failure instanceof DomainError ? failure.code : 'INTERNAL_ERROR'
      if (commitUncertain) failureCode = 'COMMAND_COMMIT_UNCERTAIN'
      if (!releaseError) {
        // Reuse this now-idle client. Asking the pool for a second connection
        // while retaining the first deadlocks a saturated pool.
        await client.query(
          `insert into management_audit (principal_id, source, action, target_key, outcome, details)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [input.principal.id, input.source, input.operation, input.targetKey, commitUncertain ? 'uncertain' : 'failed', JSON.stringify({
            commandId,
            code: failureCode,
            ...(cleanupFailed ? { cleanupFailed: true } : {}),
          })],
        ).catch(ignoreError('db', 'record failed command audit', { commandId, command: input.operation }))
      }
      throw failure
    } finally {
      if (resourceLockRequested && !releaseError) {
        await client.query('select pg_advisory_unlock(hashtext($1))', [resourceLock]).catch((error: unknown) => {
          releaseError = error instanceof Error ? error : new Error('Command resource unlock failed.')
        })
      }
      if (lifecycleLock && !releaseError) {
        await client.query('select pg_advisory_unlock(hashtext($1))', [commandLock]).catch((error: unknown) => {
          releaseError = error instanceof Error ? error : new Error('Command unlock failed.')
        })
      }
      client.release(releaseError)
    }
  }

  async recordDenied(principalId: string | undefined, source: 'http' | 'mcp' | 'device', action: string, targetKey: string): Promise<void> {
    await this.pool.query(
      `insert into management_audit (principal_id, source, action, target_key, outcome, details)
       values ($1, $2, $3, $4, 'denied', '{}'::jsonb)`,
      [principalId ?? null, source, action, targetKey],
    )
  }

  async recordAudit(
    principalId: string | undefined,
    source: 'http' | 'mcp' | 'device',
    action: string,
    targetKey: string,
    outcome: 'succeeded' | 'failed' | 'uncertain',
    details: Record<string, unknown> = {},
    client?: GraphSqlClient,
  ): Promise<void> {
    await (client ?? this.pool).query(
      `insert into management_audit (principal_id, source, action, target_key, outcome, details)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [principalId ?? null, source, action, targetKey, outcome, JSON.stringify(details)],
    )
  }
}
