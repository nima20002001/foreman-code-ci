import { asRecord } from '../shared/records.js'
import type pg from 'pg'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import type { BaseCheckpointSaver, SerializerProtocol } from '@langchain/langgraph-checkpoint'
import type { DurableInteraction } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../modules/run-graph/connection.js'
import { assertGraphTransaction } from '../modules/run-graph/connection.js'
import { DomainError } from '../modules/errors.js'
import { nextApprovalResumeValues } from './approvalCheckpointPlan.js'
import { CheckpointMutationSaver } from './checkpointMutations.js'

const INTERRUPT = '__interrupt__', RESUME = '__resume__'
const MAX_WRITE_BYTES = 262144
const MAX_CHECKPOINT_WRITE_BYTES = 2_000_000
interface StoredWrite { task_id: string; channel: string; type: string; blob: Buffer }
export function isAtomicApprovalCheckpointSaver(saver: BaseCheckpointSaver): saver is ApprovalPostgresSaver {
  return saver instanceof ApprovalPostgresSaver
}
function denied(code = 'GRAPH_INTERRUPT_INVALID'): never {
  throw new DomainError(code, 'The exact persisted approval checkpoint could not be consumed.', 409)
}

/** The SAME production PostgresSaver, not a second checkpoint table or MemorySaver.
 * Pinned ABI: checkpoint-postgres 1.0.5's protected _dumpWrites, serializer,
 * schema-qualified checkpoint_writes and reserved write indexes. Interrupt
 * persistence notifies the live Run owner after COMMIT. Approval consumption
 * uses the owner's transaction rather than the saver's private pool transaction.
 */
export class ApprovalPostgresSaver extends CheckpointMutationSaver {
  private readonly approvalSchema: string
  // Bookkeeping for writes made by THIS saver in THIS live SQL transaction.
  // Publication stages receipts until its commit finalizer. This is not a
  // durable receipt or continuation authority, and cannot cross a transaction.
  private readonly transactionWrites = new WeakMap<GraphTransactionSql, Set<string>>()
  private readonly interruptObservers = new Map<string, () => Promise<void>>()
  constructor(pool: pg.Pool, serde?: SerializerProtocol, options: { schema: string } = { schema: 'public' }) {
    if (!/^[a-z_][a-z0-9_]*$/.test(options.schema)) throw new Error('Invalid checkpoint schema')
    super(pool, serde, options)
    this.approvalSchema = options.schema
  }

  observeApprovalInterrupts(runId: string, observer: () => Promise<void>): () => void {
    if (this.interruptObservers.has(runId)) throw new DomainError(
      'RUN_ALREADY_OWNED', 'Another Run owner is observing this checkpoint.', 409)
    this.interruptObservers.set(runId, observer)
    return () => {
      if (this.interruptObservers.get(runId) === observer) this.interruptObservers.delete(runId)
    }
  }

  override async putWrites(...args: Parameters<PostgresSaver['putWrites']>): Promise<void> {
    const [config, writes] = args
    const rootInterrupt = (config.configurable?.checkpoint_ns ?? '') === ''
      && writes.some(([channel]) => channel === INTERRUPT)
    const observer = rootInterrupt ? this.interruptObservers.get(config.configurable?.thread_id) : undefined
    await super.putWrites(...args)
    await observer?.()
  }

  private async readApprovalInterrupt(sql: GraphTransactionSql,
    interaction: Pick<DurableInteraction, 'id' | 'runId' | 'graphThreadId' | 'graphInterruptId'>) {
    assertGraphTransaction(sql)
    if (interaction.runId !== interaction.graphThreadId || !interaction.graphInterruptId) denied()
    const thread = interaction.graphThreadId, namespace = ''
    // Run/head/owner locks are already held. Pin the latest root checkpoint, not
    // a historical checkpoint selected by an untrusted request or stale callback.
    const latest = (await sql.query<{ checkpoint_id: string }>(`
      select checkpoint_id from "${this.approvalSchema}".checkpoints
      where thread_id=$1 and checkpoint_ns=$2 order by checkpoint_id desc limit 1 for update`, [thread, namespace])).rows[0]
    if (!latest) denied('GRAPH_CHECKPOINT_MISSING')
    const writes = (await sql.query<StoredWrite>(`
      select task_id,channel,type,blob from "${this.approvalSchema}".checkpoint_writes
      where thread_id=$1 and checkpoint_ns=$2 and checkpoint_id=$3 and channel=any($4::text[])
      order by task_id,idx limit 2001 for update`, [thread, namespace, latest.checkpoint_id, [INTERRUPT, RESUME]])).rows
    if (writes.length > 2000 || writes.some((row) => row.blob.byteLength > MAX_WRITE_BYTES)
      || writes.reduce((bytes, row) => bytes + row.blob.byteLength, 0) > MAX_CHECKPOINT_WRITE_BYTES) denied('GRAPH_RESUME_LIMIT')
    let selected: { taskId: string; ids: string[] } | undefined
    for (const row of writes.filter((value) => value.channel === INTERRUPT)) {
      const parsed: unknown = await this.serde.loadsTyped(row.type, row.blob)
      const pendingEntries = Array.isArray(parsed) ? parsed : [parsed]
      if (pendingEntries.length > 1000) denied()
      for (const pending of pendingEntries) {
        const entry = asRecord(pending), value = asRecord(entry.value)
        if (entry.id !== interaction.graphInterruptId) continue
        const ids: unknown = value.interactionIds ?? [value.interactionId]
        if (!Array.isArray(ids) || ids.length > 1000 || !ids.length
          || ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length
          || typeof value.interactionId !== 'string' || !ids.includes(value.interactionId)) denied()
        if (!ids.includes(interaction.id)) continue
        if (selected || !row.task_id) denied()
        selected = { taskId: row.task_id, ids: ids as string[] }
      }
    }
    if (!selected) denied('GRAPH_INTERRUPT_NOT_CURRENT')
    return { thread, namespace, latest, writes, selected }
  }

  async inspectApprovalInterrupt(sql: GraphTransactionSql,
    interaction: Pick<DurableInteraction, 'id' | 'runId' | 'graphThreadId' | 'graphInterruptId'>): Promise<string> {
    return (await this.readApprovalInterrupt(sql, interaction)).latest.checkpoint_id
  }

  async consumeApprovalInterrupt(sql: GraphTransactionSql, interaction: DurableInteraction): Promise<void> {
    assertGraphTransaction(sql)
    if (interaction.graphThreadId !== interaction.runId || !interaction.graphInterruptId
      || interaction.status !== 'delivered' || interaction.deliveryState !== 'delivered') denied()
    const { thread, namespace, latest, writes, selected } = await this.readApprovalInterrupt(sql, interaction)
    const task = selected
    const resumes = writes.filter((row) => row.task_id === task.taskId && row.channel === RESUME)
    if (resumes.length > 1) denied()
    const previous: unknown = resumes[0] ? await this.serde.loadsTyped(resumes[0].type, resumes[0].blob) : []
    const plan = nextApprovalResumeValues(previous, task.ids, interaction.id)
    const key = (id: unknown) => JSON.stringify([thread, namespace, latest.checkpoint_id, task.taskId, id])
    if (!plan.changed) {
      // A previous sibling callback in this publication may have written the
      // task value while its receipt is still staged. A historical value instead
      // needs a persisted receipt; never adopt an old unreceipted Command write.
      const marker = plan.values.map(asRecord).find((value) => typeof value.interactionId === 'string'
        && task.ids.includes(value.interactionId))
      if (this.transactionWrites.get(sql)?.has(key(marker?.interactionId))) return
      const receipt = await sql.query(`select 1 from run_graph_effects
        where run_id=$1 and effect_kind='graph.resume' and entity_id=$2`, [interaction.runId, marker?.interactionId])
      if (receipt.rowCount !== 1) denied('GRAPH_RESUME_RECEIPT_MISSING')
      return
    }
    // Reuse the installed saver's actual serialization and WRITES_IDX_MAP.
    // Exactly one task-local reserved channel is changed; no node is invoked.
    const encoded = await this._dumpWrites(thread, namespace, latest.checkpoint_id, task.taskId, [[RESUME, plan.values]])
    const row = encoded[0]
    if (encoded.length !== 1 || !row || row[7].byteLength > MAX_WRITE_BYTES) denied('GRAPH_RESUME_LIMIT')
    await sql.query(`insert into "${this.approvalSchema}".checkpoint_writes
      (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,blob)
      values($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict(thread_id,checkpoint_ns,checkpoint_id,task_id,idx)
      do update set channel=excluded.channel,type=excluded.type,blob=excluded.blob`, [...row])
    const local = this.transactionWrites.get(sql) ?? new Set<string>()
    local.add(key(interaction.id))
    this.transactionWrites.set(sql, local)
  }
}
