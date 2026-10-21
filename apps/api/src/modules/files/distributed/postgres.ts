import type pg from 'pg'
import { withTransaction } from '../../../infrastructure/transaction.js'
import { ArtifactEdgeBindingSchema, type ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import { DomainError } from '../../errors.js'
import type { FileQuery } from '../repository.js'
import type { ArtifactEdgeRepository } from './edges.js'

export class PostgresArtifactEdgeRepository implements ArtifactEdgeRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(operation: (query: FileQuery) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await client.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
      const result = await operation(client)
      return result
    })
  }
  private async live(query: FileQuery, b: ArtifactEdgeBinding): Promise<void> {
    // Lock the file after grant/attempt locks. Sample wall time AFTER those waits.
    const result = await query.query(`select f.file_id from files f
      join file_revisions r on r.file_id=f.file_id and r.revision_id=$2
      join file_tool_publications p on p.file_id=r.file_id and p.revision_id=r.revision_id
      join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      where f.file_id=$1 and f.state='ready' and a.state='finalized'
        and p.owner_principal_id=$3 and p.request_id=$4 and p.binding=$5
        and r.sha256=$6 and r.byte_size=$7
        and (f.scope_kind<>'temporary' or f.expires_at>clock_timestamp()) for update of f`,
    [b.pins.fileId, b.pins.revisionId, b.publication.ownerPrincipalId, b.publication.requestId,
      b.publication.binding, b.pins.sha256, b.pins.byteSize])
    if (result.rowCount !== 1) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The exact finalized publication is unavailable.', 410)
    // PostgreSQL's WHERE may be evaluated before a row wait; resample after ownership.
    const current = await query.query(`select file_id from files where file_id=$1 and state='ready'
      and (scope_kind<>'temporary' or expires_at>clock_timestamp())`, [b.pins.fileId])
    if (current.rowCount !== 1) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned publication expired while waiting.', 410)
  }
  async pin(binding: ArtifactEdgeBinding, authorize: (query: FileQuery) => Promise<void>): Promise<ArtifactEdgeBinding> {
    const b = ArtifactEdgeBindingSchema.parse(binding)
    return this.transaction(async (query) => {
      await authorize(query); await this.live(query, b)
      await query.query(`insert into file_artifact_edges (edge_id,command_id,receiver_principal_id,file_id,revision_id,record)
        values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`,
      [b.edgeId, b.commandId, b.receiver.principalId, b.pins.fileId, b.pins.revisionId, JSON.stringify(b)])
      const result = await query.query<{ record: unknown }>(`select record from file_artifact_edges
        where edge_id=$1 or (receiver_principal_id=$2 and command_id=$3)`, [b.edgeId, b.receiver.principalId, b.commandId])
      const current = result.rows[0] && ArtifactEdgeBindingSchema.parse(result.rows[0].record)
      if (result.rowCount !== 1 || !current || JSON.stringify(current) !== JSON.stringify(b)) {
        throw new DomainError('FILE_EDGE_CONFLICT', 'The edge identity is already bound to different input.', 409)
      }
      return current
    })
  }
  async read(edgeId: string): Promise<ArtifactEdgeBinding | undefined> {
    const result = await this.pool.query<{ record: unknown }>('select record from file_artifact_edges where edge_id=$1', [edgeId])
    return result.rows[0] ? ArtifactEdgeBindingSchema.parse(result.rows[0].record) : undefined
  }
  async recordRead(b: ArtifactEdgeBinding, readAt: string, authorize: (query: FileQuery) => Promise<void>): Promise<void> {
    await this.transaction(async (query) => {
      await authorize(query); await this.live(query, b)
      await query.query(`insert into file_tool_read_provenance (binding,run_id,execution_id,file_id,revision_id,read_at)
        values ($1,$2,$3,$4,$5,$6)`, [`edge:${b.edgeId}`, b.consumer.runId, b.consumer.executionId, b.pins.fileId, b.pins.revisionId, readAt])
      await query.query(`insert into file_artifact_edge_reads (edge_id,consumer_execution_id,consumer_attempt_id,read_at)
        values ($1,$2,$3,$4)`, [b.edgeId, b.consumer.executionId, b.consumer.attemptId, readAt])
    })
  }
}
