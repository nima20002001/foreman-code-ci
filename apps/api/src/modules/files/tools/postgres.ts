import type pg from 'pg'
import type { MessageAttachmentRef, RunFileProvenance } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import { bindingIdentity } from './context.js'
import type { ArtifactSnapshot, CopyReceipt, FileToolArtifact,
  FileToolRepository, FileToolSession, PublicationLink } from './types.js'

export class PostgresFileToolRepository implements FileToolRepository {
  constructor(private readonly pool: pg.Pool) {}
  async putSession(tokenHash: string, session: FileToolSession): Promise<void> {
    const binding = bindingIdentity(session.context)
    // Serialize issuance with retirement of this exact turn, without storing the bearer token.
    await this.pool.query(`with ownership as materialized (
      select pg_advisory_xact_lock(hashtextextended($4,273605))
    ) insert into file_tool_sessions (token_hash,record,expires_at)
      select $1,$2::jsonb,$3::timestamptz from ownership`,
    [tokenHash, JSON.stringify({ ...session, binding }), session.expiresAt, binding])
  }
  async session(tokenHash: string, asOfUtc: string): Promise<FileToolSession | undefined> {
    return (await this.pool.query<{ record: FileToolSession }>(`select record - 'binding' as record from file_tool_sessions
      where token_hash=$1 and revoked_at is null and expires_at>$2`, [tokenHash, asOfUtc])).rows[0]?.record
  }
  async renewSession(tokenHash: string, expiresAt: string, asOfUtc: string): Promise<boolean> {
    const result = await this.pool.query(`update file_tool_sessions set expires_at=$2::timestamptz,
      record=jsonb_set(record,'{expiresAt}',to_jsonb($2::text)) where token_hash=$1 and revoked_at is null and expires_at>$3`,
    [tokenHash, expiresAt, asOfUtc])
    return result.rowCount === 1
  }
  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query('update file_tool_sessions set revoked_at=coalesce(revoked_at,now()) where token_hash=$1', [tokenHash])
  }
  async createArtifact(artifact: FileToolArtifact): Promise<void> {
    await this.pool.query('insert into file_tool_artifacts (artifact_id,binding,record) values ($1,$2,$3::jsonb)',
      [artifact.artifactId, artifact.binding, JSON.stringify(artifact)])
  }
  async artifact(binding: string, artifactId: string): Promise<FileToolArtifact | undefined> {
    return (await this.pool.query<{ record: FileToolArtifact }>(
      'select record from file_tool_artifacts where artifact_id=$1 and binding=$2', [artifactId, binding])).rows[0]?.record
  }
  async beginWrite(binding: string, artifactId: string, writeId: string, baseRevisionId?: string): Promise<boolean> {
    const result = await this.pool.query(`update file_tool_artifacts set record=record || $3::jsonb
      where artifact_id=$1 and binding=$2 and record->>'state' in ('complete','failed')
        and record->>'retiredAt' is null
        and ($4::text is null or record #>> '{snapshot,revision,revisionId}'=$4::text)`,
    [artifactId, binding, JSON.stringify({ state: 'writing', writeId }), baseRevisionId ?? null])
    return result.rowCount === 1
  }
  async registerStorage(binding: string, artifactId: string, writeId: string, storageKey: string): Promise<boolean> {
    const result = await this.pool.query(`update file_tool_artifacts set record=jsonb_set(record,'{storageKeys}',
      coalesce(record->'storageKeys','[]'::jsonb) || jsonb_build_array($4::text) ||
      case when record #>> '{snapshot,storageKey}' is not null
        and not (coalesce(record->'storageKeys','[]'::jsonb) ? (record #>> '{snapshot,storageKey}'))
        then jsonb_build_array(record #>> '{snapshot,storageKey}') else '[]'::jsonb end)
      where artifact_id=$1 and binding=$2 and record->>'writeId'=$3
        and record->>'state'='writing' and record->>'retiredAt' is null`,
    [artifactId, binding, writeId, storageKey])
    return result.rowCount === 1
  }
  async finishWrite(binding: string, artifactId: string, writeId: string, snapshot: ArtifactSnapshot): Promise<boolean> {
    const result = await this.pool.query(`update file_tool_artifacts set record=record || $4::jsonb
      where artifact_id=$1 and binding=$2 and record->>'writeId'=$3 and record->>'state'='writing'
        and record->>'retiredAt' is null`,
    [artifactId, binding, writeId, JSON.stringify({ state: 'complete', snapshot })])
    return result.rowCount === 1
  }
  async failWrite(binding: string, artifactId: string, writeId: string): Promise<void> {
    await this.pool.query(`update file_tool_artifacts set record=record || '{"state":"failed"}'::jsonb
      where artifact_id=$1 and binding=$2 and record->>'writeId'=$3 and record->>'state'='writing'`, [artifactId, binding, writeId])
  }
  async copyReceipt(ownerPrincipalId: string, commandId: string): Promise<CopyReceipt | undefined> {
    return (await this.pool.query<{ record: CopyReceipt }>(
      'select record from file_tool_copy_receipts where owner_principal_id=$1 and command_id=$2', [ownerPrincipalId, commandId])).rows[0]?.record
  }
  async saveCopyReceipt(receipt: CopyReceipt): Promise<CopyReceipt> {
    await this.pool.query(`insert into file_tool_copy_receipts (owner_principal_id,command_id,record)
      values ($1,$2,$3::jsonb) on conflict (owner_principal_id,command_id) do nothing`,
    [receipt.ownerPrincipalId, receipt.commandId, JSON.stringify(receipt)])
    const current = await this.copyReceipt(receipt.ownerPrincipalId, receipt.commandId)
    if (!current || current.inputHash !== receipt.inputHash) throw new DomainError('FILE_REQUEST_CONFLICT', 'commandId was already used for another working copy.', 409)
    return current
  }
  async linkPublication(link: PublicationLink): Promise<void> {
    // This commit MUST precede FIL-03 finalize. A ready result can never lack its durable turn link.
    await this.pool.query(`insert into file_tool_publications
      (owner_principal_id,request_id,binding,file_id,revision_id,record)
      values ($1,$2,$3,$4,$5,$6::jsonb) on conflict (owner_principal_id,request_id) do nothing`,
    [link.ownerPrincipalId, link.requestId, link.binding, link.ref.fileId, link.ref.revisionId, JSON.stringify(link)])
    const current = (await this.pool.query<{ binding: string; file_id: string; revision_id: string }>(
      'select binding,file_id,revision_id from file_tool_publications where owner_principal_id=$1 and request_id=$2',
      [link.ownerPrincipalId, link.requestId])).rows[0]
    if (!current || current.binding !== link.binding || current.file_id !== link.ref.fileId || current.revision_id !== link.ref.revisionId) {
      throw new DomainError('FILE_REQUEST_CONFLICT', 'The publication is already linked to different content or a different turn.', 409)
    }
  }
  async publications(binding: string): Promise<MessageAttachmentRef[]> {
    // Pending links deliberately are not message attachments until FIL-03 marks their file ready.
    const rows = (await this.pool.query<{ file_id: string; revision_id: string }>(`select p.file_id,p.revision_id
      from file_tool_publications p join file_allocations a
        on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      where p.binding=$1 and a.state='finalized' order by p.record->>'createdAt',p.request_id`, [binding])).rows
    return rows.map((row) => ({ fileId: row.file_id, revisionId: row.revision_id }))
  }
  async recordRead(binding: string, provenance: RunFileProvenance): Promise<void> {
    await this.pool.query(`insert into file_tool_read_provenance (binding,run_id,execution_id,file_id,revision_id,read_at)
      values ($1,$2,$3,$4,$5,$6)`, [binding, provenance.runId, provenance.executionId, provenance.fileId, provenance.revisionId, provenance.readAt])
  }
}
