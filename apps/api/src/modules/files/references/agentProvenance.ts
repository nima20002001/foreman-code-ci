import type pg from 'pg'
import { withTransaction } from '../../../infrastructure/transaction.js'
import { RunFileProvenanceSchema, type AgentFileReadInput } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import type { FileQuery } from '../repository.js'
import type { AgentReferenceContext, ReferenceReadRepository } from './agentTypes.js'

/** Run-wide first-use pins plus immutable per-execution first-read facts. */
export class PostgresReferenceReadRepository implements ReferenceReadRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Admission already pins temporary revisions. They never become permanent Run reference pins. */
  async completeAttachment(context: AgentReferenceContext, ref: Pick<AgentFileReadInput, 'fileId' | 'revisionId'>,
    reauthorize: (query: FileQuery) => Promise<void>): Promise<'ready' | 'pending' | 'removed' | 'not_found'> {
    return withTransaction(this.pool, async client => {
      await reauthorize(client)
      const row = (await client.query<{ state: string }>(`select f.state from files f
        join file_revisions v on v.file_id=f.file_id and v.revision_id=$2
        where f.file_id=$1 and f.scope_kind='temporary' and f.workspace_id=$3 and f.workflow_id=$4
          and f.run_id=$5 and f.agent_id=$6 and f.expires_at>clock_timestamp() for share of f`,
      [ref.fileId, ref.revisionId, context.workspaceId, context.workflowId, context.runId, context.agentId])).rows[0]
      return row?.state === 'ready' || row?.state === 'pending' || row?.state === 'removed' ? row.state : 'not_found'
    })
  }

  async pinned(runId: string, fileIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (fileIds.length === 0) return new Map()
    const result = await this.pool.query<{ file_id: string; revision_id: string }>(
      'select file_id,revision_id from run_reference_file_pins where run_id=$1 and file_id=any($2::text[])', [runId, [...fileIds]])
    return new Map(result.rows.map((row) => [row.file_id, row.revision_id]))
  }

  async complete(context: AgentReferenceContext, ref: Pick<AgentFileReadInput, 'fileId' | 'revisionId'>,
    readAt: string, reauthorize: (query: FileQuery) => Promise<void>): Promise<'ready' | 'pending' | 'removed' | 'not_found'> {
    const fact = context.runId === undefined ? undefined : RunFileProvenanceSchema.parse({
      runId: context.runId, executionId: context.executionId, ...ref, readAt,
    })
    return withTransaction(this.pool, async (client) => {
      // Same lock order as management: authority first, file second. No filesystem I/O under these locks.
      await reauthorize(client)
      const result = await client.query<{ state: string }>(`select f.state from files f
        join file_revisions v on v.file_id=f.file_id and v.revision_id=$2
        where f.file_id=$1 and f.workspace_id=$3 and
          ((f.scope_kind='workspace_reference' and f.workflow_id is null)
            or (f.scope_kind='workflow_reference' and f.workflow_id=$4))
        for share of f`, [ref.fileId, ref.revisionId, context.workspaceId, context.workflowId])
      const state = result.rows[0]?.state
      if (state !== 'ready') {
        return state === 'pending' || state === 'removed' ? state : 'not_found'
      }
      if (fact) {
        const execution = await client.query(`select e.id from harness_executions e join runs r on r.id=e.run_id
          where e.id=$1 and r.id=$2 and e.agent_id=$3 and r.workspace_id=$4 and r.workflow_id=$5 for share of e,r`,
        [fact.executionId, fact.runId, context.agentId, context.workspaceId, context.workflowId])
        if (execution.rowCount !== 1) {
          throw new DomainError('FILE_REFERENCE_ACCESS_DENIED', 'The Run and execution no longer match the reference caller.', 403)
        }
        // The unique (run_id,file_id) key serializes independent processes, including different executions.
        // The losing contender must read/compare, never update the winning pin.
        await client.query(`insert into run_reference_file_pins(run_id,file_id,revision_id) values($1,$2,$3)
          on conflict (run_id,file_id) do nothing`, [fact.runId, fact.fileId, fact.revisionId])
        const pin = await client.query<{ revision_id: string }>(
          'select revision_id from run_reference_file_pins where run_id=$1 and file_id=$2', [fact.runId, fact.fileId])
        if (pin.rows[0]?.revision_id !== fact.revisionId) {
          throw new DomainError('FILE_REFERENCE_PIN_CONFLICT', 'This Run already read a different immutable revision of this file.', 409)
        }
        await client.query(`insert into run_reference_file_reads(run_id,execution_id,file_id,revision_id,read_at)
          values($1,$2,$3,$4,$5::timestamptz) on conflict (run_id,execution_id,file_id) do nothing`,
        [fact.runId, fact.executionId, fact.fileId, fact.revisionId, fact.readAt])
      }
      return 'ready'
    })
  }
}
