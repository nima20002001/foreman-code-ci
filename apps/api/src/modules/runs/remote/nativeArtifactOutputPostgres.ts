import { createHash } from 'node:crypto'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../../../infrastructure/transaction.js'
import { isDeepStrictEqual as same } from 'node:util'
import type pg from 'pg'
import { z } from 'zod'
import { ArtifactAttemptSchema, ArtifactEdgeBindingSchema, type ArtifactAttempt } from '@foreman-code/contracts/artifact-edges'
import { VerifiedTransferReceiptSchema } from '@foreman-code/contracts/byte-transfer'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { cancelBackendQuery } from '../../../infrastructure/pool.js'
import { componentLogger } from '../../diagnostics/logger.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import type { FileQuery } from '../../files/repository.js'
import { fileScopeIdentity } from '../../files/requests.js'
import { DomainError } from '../../errors.js'
import { NativeArtifactOutputSchema, LocalNativeArtifactOutputSchema, WorkflowNativeArtifactOutputSchema,
  type LocalNativeArtifactOutput, type WorkflowNativeArtifactOutput, type NativeArtifactOutput,
  type NativeArtifactOutputRepository } from './nativeArtifactOutputs.js'

const operation = 'remote.native-artifact.output'
const conflict = (): never => { throw new DomainError('NATIVE_ARTIFACT_OUTPUT_CONFLICT', 'The original native output slot identifies different canonical facts.', 409) }
const unavailable = (): never => { throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The exact finalized canonical publication is unavailable.', 410) }

function outputTarget(mainId: string, producer: ArtifactAttempt, outputKey: string): string {
  producer = ArtifactAttemptSchema.parse(producer)
  outputKey = ArtifactEdgeBindingSchema.shape.outputKey.parse(outputKey)
  return JSON.stringify([mainId, producer.executionId, producer.attemptId, outputKey])
}
function validateOutput(mainId: string, record: WorkflowNativeArtifactOutput): void {
  const { producer, scope } = record
  if ('transferReceipt' in record) {
    const receipt = record.transferReceipt, intent = receipt.intent
    if (intent.mainId !== mainId || intent.executionId !== producer.executionId || intent.attemptId !== producer.attemptId
    || intent.placementHash !== producer.placementHash || intent.direction !== 'to-main' || intent.byteClass !== 'artifact'
    || receipt.sha256 !== record.pins.sha256 || receipt.byteSize !== record.pins.byteSize) conflict()
  } else {
    const local = record.localPublication
    if (local.mainId !== mainId || local.executionId !== producer.executionId || local.attemptId !== producer.attemptId
      || local.placementHash !== producer.placementHash) conflict()
  }
  if (scope.kind !== 'temporary' || scope.chat.kind !== 'agent' || scope.chat.workspaceId !== producer.workspaceId
    || scope.chat.workflowId !== producer.workflowId || scope.chat.runId !== producer.runId || scope.chat.executionId !== producer.executionId) conflict()
}

export async function assertNativeArtifactOutputLive(query: FileQuery, mainId: string,
  record: WorkflowNativeArtifactOutput): Promise<void> {
    validateOutput(mainId, record)
    const result = await query.query<{ record: DistributedPublicationLink }>(`select p.record from file_tool_publications p
      join file_revisions r on r.file_id=p.file_id and r.revision_id=p.revision_id
      join files f on f.file_id=r.file_id
      join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      where p.owner_principal_id=$1 and p.request_id=$2 and p.binding=$3 and p.file_id=$4 and p.revision_id=$5
        and r.sha256=$6 and r.byte_size=$7 and f.state='ready' and a.state='finalized'
        and f.scope_kind='temporary' and f.expires_at>clock_timestamp() for update of f`,
    [record.publication.ownerPrincipalId, record.publication.requestId, record.publication.binding,
      record.pins.fileId, record.pins.revisionId, record.pins.sha256, record.pins.byteSize])
    const link = result.rows[0]?.record
    if (result.rowCount !== 1 || !link) return unavailable()
    const native = { nativeSessionId: link.context.nativeSessionId, ...(link.context.turnId ? { turnId: link.context.turnId } : {}),
      ...(link.context.nativeMessageId ? { nativeMessageId: link.context.nativeMessageId } : {}), ...(link.context.messageId ? { messageId: link.context.messageId } : {}) }
    if (link.ownerPrincipalId !== record.publication.ownerPrincipalId || link.requestId !== record.publication.requestId
      || link.binding !== record.publication.binding || !same(link.ref, { fileId: record.pins.fileId, revisionId: record.pins.revisionId })
      || !same(native, record.nativeIdentity) || fileScopeIdentity(link.context.scope) !== fileScopeIdentity(record.scope)) conflict()
    if ('transferReceipt' in record) {
      if (!same(VerifiedTransferReceiptSchema.parse(link.transferReceipt), record.transferReceipt)) conflict()
    } else if (link.transferReceipt) conflict()
    // Resample after the file row wait; the initial WHERE can predate lock acquisition.
    if ((await query.query(`select file_id from files where file_id=$1 and state='ready' and expires_at>clock_timestamp()`, [record.pins.fileId])).rowCount !== 1) unavailable()
  }

/** Existing command/publication ledgers only. mainId is captured from the installed Main identity. */
export class PostgresNativeArtifactOutputRepository implements NativeArtifactOutputRepository {
  private readonly mainId: string
  constructor(private readonly pool: pg.Pool, mainId: string) { this.mainId = z.uuid().parse(mainId) }
  private target(producer: ArtifactAttempt, outputKey: string): string { return outputTarget(this.mainId, producer, outputKey) }
  async bind(raw: NativeArtifactOutput, authorize: (query: FileQuery) => Promise<void>,
    signal?: AbortSignal): Promise<NativeArtifactOutput> {
    return this.bindOutput(NativeArtifactOutputSchema.parse(raw), authorize, signal)
  }
  async bindLocal(raw: LocalNativeArtifactOutput, authorize: (query: FileQuery) => Promise<void>,
    signal?: AbortSignal): Promise<LocalNativeArtifactOutput> {
    return this.bindOutput(LocalNativeArtifactOutputSchema.parse(raw), authorize, signal)
  }
  private async bindOutput<T extends WorkflowNativeArtifactOutput>(record: T,
    authorize: (query: FileQuery) => Promise<void>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    validateOutput(this.mainId, record)
    const target = this.target(record.producer, record.outputKey), serialized = canonicalGraphJson(record)
    const commandId = createHash('sha256').update(target).digest('hex'), inputHash = createHash('sha256').update(serialized).digest('hex')
    const client = await this.pool.connect()
    let released = false
    let processId: number | undefined
    let cancellation: Promise<void> | undefined
    const abort = () => {
      if (released) return
      if (processId === undefined) {
        released = true
        client.release(true)
        return
      }
      cancellation ??= cancelBackendQuery(this.pool.options, processId).catch((error: unknown) => {
        componentLogger('db').error({ err: error }, 'Artifact binding cancellation failed; discarding its connection')
        released = true
        client.release(true)
      })
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) {
        abort()
        signal.throwIfAborted()
      }
      processId = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      signal?.throwIfAborted()
      await beginTransaction(client)
      await client.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
      await authorize(client)
      await assertNativeArtifactOutputLive(client, this.mainId, record)
      signal?.throwIfAborted()
      const inserted = await client.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
        values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`, [record.publication.ownerPrincipalId, operation, commandId, target, inputHash, serialized])
      const stored = await client.query<{ principal_id: string; input_hash: string; result: unknown }>(`select principal_id,input_hash,result from management_command_receipts
        where operation=$1 and target_key=$2`, [operation, target])
      const original = stored.rows[0]
      if (stored.rowCount !== 1 || !original || original.principal_id !== record.publication.ownerPrincipalId
        || original.input_hash !== inputHash || !same(WorkflowNativeArtifactOutputSchema.parse(original.result), record)) conflict()
      // Revalidate after all canonical/receipt row waits, including an idempotent readback.
      await authorize(client)
      await assertNativeArtifactOutputLive(client, this.mainId, record)
      if (inserted.rowCount === 1) await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,$2,$3,$4,'succeeded',$5::jsonb)`,
      [record.publication.ownerPrincipalId, 'transferReceipt' in record ? 'device' : 'mcp', operation, target,
        JSON.stringify({ commandId: record.commandId })])
      await commitTransaction(client)
      return structuredClone(record)
    } catch (error) {
      signal?.throwIfAborted()
      try { await rollbackTransaction(client) }
      catch (rollbackError) {
        signal?.throwIfAborted()
        throw new AggregateError([error, rollbackError], 'Artifact binding and rollback both failed.', {
          cause: rollbackError,
        })
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      if (cancellation) await cancellation
      if (!released) client.release(signal?.aborted === true)
    }
  }
  read(producer: ArtifactAttempt, outputKey: string): Promise<NativeArtifactOutput | undefined> {
    return readNativeArtifactOutput(this.pool, this.mainId, producer, outputKey)
  }
}
/** Reuses the caller's authority transaction; does not open a second pool connection. */
export async function readNativeArtifactOutput(query: FileQuery, mainId: string, producer: ArtifactAttempt,
  outputKey: string): Promise<NativeArtifactOutput | undefined> {
  const result = await query.query<{ result: unknown }>('select result from management_command_receipts where operation=$1 and target_key=$2',
    [operation, outputTarget(mainId, producer, outputKey)])
  if (!result.rows[0]) return undefined
  const original = NativeArtifactOutputSchema.parse(result.rows[0].result)
  validateOutput(mainId, original)
  if (result.rowCount !== 1 || !same(original.producer, producer) || original.outputKey !== outputKey) conflict()
  return original
}

export async function readLocalNativeArtifactOutput(query: FileQuery, mainId: string, producer: ArtifactAttempt,
  outputKey: string): Promise<LocalNativeArtifactOutput | undefined> {
  const result = await query.query<{ result: unknown }>(
    'select result from management_command_receipts where operation=$1 and target_key=$2',
    [operation, outputTarget(mainId, producer, outputKey)])
  if (!result.rows[0]) return undefined
  const original = LocalNativeArtifactOutputSchema.parse(result.rows[0].result)
  validateOutput(mainId, original)
  if (result.rowCount !== 1 || !same(original.producer, producer) || original.outputKey !== outputKey) conflict()
  return original
}
