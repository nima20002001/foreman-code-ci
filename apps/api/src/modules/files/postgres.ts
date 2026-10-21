import { createHash } from 'node:crypto'
import { withClientTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { z } from 'zod'
import {
  MAX_FILE_PAGE_SIZE, FileSchema, FileScopeSchema, FileWithRevisionSchema, FilePageSchema, fileStateAt,
  type FileScope, type File, PermanentFileScopeSchema, MessageAttachmentRefSchema,
  type PermanentFileScope, type MessageAttachmentRef,
} from '@foreman-code/contracts/files'

import { DomainError } from '../errors.js'
import type { AllocationSession, AllocationState, FileAllocation, FileReferenceRepository,
  FileMutationContext, NewStoredFile, StoredFile, FileQuery } from './repository.js'
import { ignoreError } from '../diagnostics/ignoredError.js'

type Query = FileQuery
interface FileRow {
  file_id: string; owner_principal_id: string; current_revision_id: string; scope_kind: FileScope['kind']
  chat_kind: 'operator' | 'agent' | null; operator_id: string | null; conversation_id: string | null
  agent_id: string | null; workspace_id: string | null; workflow_id: string | null
  run_id: string | null; execution_id: string | null; job_execution_id?: string | null; state: File['state']; created_at: Date
  retention_duration_seconds: number | null; expires_at: Date | null
}
interface RevisionRow extends FileRow {
  revision_id: string; filename: string; media_type: string; byte_size: string; sha256: string
  origin: string; revision_created_at: Date; storage_key: string
}
interface AllocationRow extends RevisionRow {
  allocation_id: string; request_id: string; input_hash: string; allocation_state: AllocationState
}
const projection = `f.*,r.revision_id,r.filename,r.media_type,r.byte_size,r.sha256,r.origin,
  r.created_at as revision_created_at,r.storage_key`
const CursorSchema = z.object({ scope: z.string(), createdAt: z.string().datetime(), fileId: z.string().min(1).max(200) }).strict()

/** Every absent scope column is SQL NULL with exact matching, never an authorization wildcard. */
function scopeColumns(input: FileScope): Record<string, string | null> {
  const scope = FileScopeSchema.parse(input)
  const base: Record<string, string | null> = { scope_kind: scope.kind, chat_kind: null, operator_id: null,
    conversation_id: null, agent_id: null, workspace_id: null, workflow_id: null, run_id: null, execution_id: null }
  if (scope.kind === 'job_execution') {
    base.workspace_id = scope.workspaceId; base.job_execution_id = scope.jobExecutionId
  } else if (scope.kind !== 'temporary') {
    base.workspace_id = scope.workspaceId
    if (scope.kind === 'workflow_reference') base.workflow_id = scope.workflowId
  } else {
    const chat = scope.chat
    base.chat_kind = chat.kind; base.conversation_id = chat.conversationId
    if (chat.kind === 'operator') base.operator_id = chat.operatorId
    else {
      base.agent_id = chat.agentId; base.workspace_id = chat.workspaceId; base.workflow_id = chat.workflowId
      base.run_id = chat.runId ?? null; base.execution_id = chat.executionId ?? null
    }
  }
  return base
}
function scopeKey(scope: FileScope): string {
  const columns = scopeColumns(scope)
  return createHash('sha256').update(JSON.stringify([Object.values(columns), scope.kind === 'temporary' && scope.chat.kind === 'operator'
    ? scope.chat.ownerPrincipalId : null])).digest('hex')
}
function file(row: FileRow): File {
  const scope = row.scope_kind === 'job_execution'
    ? { kind: 'job_execution', workspaceId: row.workspace_id, jobExecutionId: row.job_execution_id }
    : row.scope_kind === 'temporary'
    ? { kind: 'temporary', chat: row.chat_kind === 'operator'
      ? { kind: 'operator', ownerPrincipalId: row.owner_principal_id, operatorId: row.operator_id, conversationId: row.conversation_id }
      : { kind: 'agent', conversationId: row.conversation_id, agentId: row.agent_id, workspaceId: row.workspace_id,
        workflowId: row.workflow_id, ...(row.run_id ? { runId: row.run_id, executionId: row.execution_id } : {}) } }
    : { kind: row.scope_kind, workspaceId: row.workspace_id,
      ...(row.scope_kind === 'workflow_reference' ? { workflowId: row.workflow_id } : {}) }
  return FileSchema.parse({ fileId: row.file_id, currentRevisionId: row.current_revision_id, scope,
    state: row.state, createdAt: row.created_at.toISOString(), ...(row.scope_kind === 'temporary' || row.scope_kind === 'job_execution'
      ? { retentionDurationSeconds: row.retention_duration_seconds, expiresAt: row.expires_at!.toISOString() } : {}) })
}
function stored(row: RevisionRow): StoredFile {
  return { value: FileWithRevisionSchema.parse({ file: file(row), revision: { fileId: row.file_id,
    revisionId: row.revision_id, filename: row.filename, mediaType: row.media_type, byteSize: Number(row.byte_size),
    sha256: row.sha256, origin: row.origin, ...(row.origin === 'job_output' ? { byteClass: 'ci-output' } : {}), createdAt: row.revision_created_at.toISOString() } }),
  ownerPrincipalId: row.owner_principal_id, storageKey: row.storage_key }
}
function allocation(row: AllocationRow): FileAllocation {
  return { allocationId: row.allocation_id, requestId: row.request_id, inputHash: row.input_hash,
    state: row.allocation_state, stored: stored(row) }
}
/** Bytes live only in FileByteStorage. This repository also serves FIL-04/05/36. */
export class PostgresFileRepository implements FileReferenceRepository {
  constructor(private readonly pool: pg.Pool,
    private readonly retentionSnapshot?: (client: pg.PoolClient, ownerPrincipalId: string) => Promise<number>) {}

  private async insert(query: Query, input: NewStoredFile): Promise<void> {
    const value = FileWithRevisionSchema.parse(input.value)
    const { file: f, revision: r } = value
    if (f.currentRevisionId !== r.revisionId) throw new Error('Initial file head must pin its first revision.')
    if (f.scope.kind === 'temporary' && f.scope.chat.kind === 'operator' && f.scope.chat.ownerPrincipalId !== input.ownerPrincipalId) {
      throw new Error('Operator scope and retention owner must match.')
    }
    const columns = scopeColumns(f.scope)
    await query.query(`insert into files (file_id,owner_principal_id,current_revision_id,
      ${Object.keys(columns).join(',')},state,created_at,retention_duration_seconds,expires_at)
      values (${Array.from({ length: 7 + Object.keys(columns).length }, (_, i) => `$${i + 1}`).join(',')})`,
    [f.fileId, input.ownerPrincipalId, f.currentRevisionId, ...Object.values(columns), f.state, f.createdAt,
      ...('expiresAt' in f ? [f.retentionDurationSeconds, f.expiresAt] : [null, null])])
    await query.query(`insert into file_revisions
      (revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [r.revisionId, r.fileId, r.filename, r.mediaType, r.byteSize, r.sha256, r.origin, r.createdAt, input.storageKey])
  }

  async create(input: NewStoredFile): Promise<StoredFile> {
    const client = await this.pool.connect()
    try { await withClientTransaction(client, () => this.insert(client, input)); return (await this.read(input.value.file.fileId, input.value.revision.revisionId, client))! }
    finally { client.release() }
  }

  async read(fileId: string, revisionId: string, query: Query = this.pool): Promise<StoredFile | undefined> {
    const result = await query.query<RevisionRow>(`select ${projection} from files f join file_revisions r
      on r.file_id=f.file_id where f.file_id=$1 and r.revision_id=$2`, [fileId, revisionId])
    return result.rows[0] ? stored(result.rows[0]) : undefined
  }

  async readMany(pins: readonly { fileId: string; revisionId: string }[], query: Query = this.pool): Promise<StoredFile[]> {
    if (pins.length === 0) return []
    const result = await query.query<RevisionRow>(`select ${projection} from files f join file_revisions r
      on r.file_id=f.file_id join unnest($1::text[],$2::text[]) as pins(file_id,revision_id)
      on pins.file_id=f.file_id and pins.revision_id=r.revision_id`,
    [pins.map(pin => pin.fileId), pins.map(pin => pin.revisionId)])
    return result.rows.map(stored)
  }

  async list(scope: FileScope, page: { cursor?: string; limit: number }, asOfUtc: string) {
    scope = FileScopeSchema.parse(scope)
    z.string().datetime().parse(asOfUtc)
    const limit = z.number().int().min(1).max(MAX_FILE_PAGE_SIZE).parse(page.limit)
    const key = scopeKey(scope)
    const args: unknown[] = []
    const conditions = Object.entries(scopeColumns(scope)).map(([column, value]) => {
      if (value === null) return `f.${column} is null`
      args.push(value); return `f.${column}=$${args.length}`
    })
    if (scope.kind === 'temporary' && scope.chat.kind === 'operator') {
      args.push(scope.chat.ownerPrincipalId); conditions.push(`f.owner_principal_id=$${args.length}`)
    }
    if (page.cursor) {
      let cursor: z.infer<typeof CursorSchema>
      try {
        if (page.cursor.length > 2048) throw new Error('Cursor too long')
        cursor = CursorSchema.parse(JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')))
        if (cursor.scope !== key) throw new Error('Cursor scope mismatch')
      } catch { throw new DomainError('FILE_CURSOR_INVALID', 'The cursor does not belong to this file list.', 400) }
      args.push(cursor.createdAt, cursor.fileId)
      conditions.push(`(f.created_at,f.file_id)>($${args.length - 1}::timestamptz,$${args.length})`)
    }
    args.push(limit + 1)
    const result = await this.pool.query<RevisionRow>(`select ${projection} from files f join file_revisions r
      on r.file_id=f.file_id and r.revision_id=f.current_revision_id where ${conditions.join(' and ')}
      order by f.created_at,f.file_id limit $${args.length}`, args)
    const rows = result.rows.slice(0, limit)
    const last = rows.at(-1)
    return FilePageSchema.parse({ items: rows.map((row) => {
      const value = stored(row).value
      return { ...value, file: { ...value.file, state: fileStateAt(value.file, asOfUtc) } }
    }), pageInfo: { nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify({ scope: key,
      createdAt: last.created_at.toISOString(), fileId: last.file_id })).toString('base64url') : null } })
  }

  async markExpired(fileId: string, asOfUtc: string): Promise<File | undefined> {
    z.string().datetime().parse(asOfUtc)
    const result = await this.pool.query<FileRow>(`update files set state='expired' where file_id=$1
      and scope_kind in ('temporary','job_execution') and state in ('pending','ready') and expires_at<=$2::timestamptz returning *`, [fileId, asOfUtc])
    return result.rows[0] ? file(result.rows[0]) : undefined
  }

  async removeReference(scope: PermanentFileScope, ref: MessageAttachmentRef, query: Query) {
    scope = PermanentFileScopeSchema.parse(scope)
    ref = MessageAttachmentRefSchema.parse(ref)
    // A row lock serializes removal with setState below. Publication may finish its disk link,
    // but its conditional metadata update can never turn this tombstone back into a ready file.
    const removed = await query.query(`update files set state='removed' where file_id=$1
      and current_revision_id=$2 and scope_kind=$3 and workspace_id=$4
      and workflow_id is not distinct from $5::text returning file_id`,
    [ref.fileId, ref.revisionId, scope.kind, scope.workspaceId,
      scope.kind === 'workflow_reference' ? scope.workflowId : null])
    if (!removed.rowCount) throw new DomainError('FILE_NOT_FOUND', 'The pinned reference was not found in this scope.', 404)
    await query.query("update file_allocations set state='canceled' where file_id=$1 and state<>'finalized'", [ref.fileId])
    return (await this.read(ref.fileId, ref.revisionId, query))!.value
  }

  async withAllocation<T>(ownerPrincipalId: string, requestId: string,
    operation: (session: AllocationSession) => Promise<T>, mutation?: FileMutationContext): Promise<T> {
    const client = await this.pool.connect()
    const lockKey = JSON.stringify(['file-allocation', ownerPrincipalId, requestId])
    let locked = false
    let broken = false
    const onError = () => { broken = true }
    client.on('error', onError)
    const check = () => { if (broken) throw new DomainError('FILE_STORAGE_UNAVAILABLE', 'Allocation ownership was lost. Retry the same request.', 503) }
    const read = async () => {
      check()
      const result = await client.query<AllocationRow>(`select ${projection},a.allocation_id,a.request_id,a.input_hash,
        a.state as allocation_state from file_allocations a join files f on f.file_id=a.file_id
        join file_revisions r on r.file_id=a.file_id and r.revision_id=a.revision_id
        where a.owner_principal_id=$1 and a.request_id=$2`, [ownerPrincipalId, requestId])
      return result.rows[0] ? allocation(result.rows[0]) : undefined
    }
    const auditReference = async (value: FileAllocation, action: string) => {
      if (value.stored.value.file.scope.kind === 'temporary') return
      await client.query(`insert into management_audit (principal_id,source,action,target_key,outcome,details)
        values ($1,$2,$3,$4,'succeeded',$5::jsonb)`, [ownerPrincipalId, mutation?.source ?? 'http', value.stored.value.file.scope.kind === 'job_execution' ? action.replace('reference_file.', 'job_artifact.') : action,
        `file:${value.stored.value.file.fileId}`, JSON.stringify({ requestId, revisionId: value.stored.value.revision.revisionId })])
    }
    try {
      const result = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,273601)) as locked', [lockKey])
      locked = result.rows[0]?.locked === true
      if (!locked) throw new DomainError('FILE_UPLOAD_BUSY', 'This upload is being committed. Retry the same request.', 409)
      await mutation?.authorize(client)
      const insertAllocation = async (value: FileAllocation) => {
        check()
        if (value.stored.ownerPrincipalId !== ownerPrincipalId || value.requestId !== requestId) throw new Error('Allocation identity mismatch.')
        await mutation?.authorize(client)
        await this.insert(client, value.stored)
        await client.query(`insert into file_allocations (allocation_id,owner_principal_id,request_id,input_hash,file_id,revision_id,state,created_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8)`, [value.allocationId, ownerPrincipalId, requestId, value.inputHash,
          value.stored.value.file.fileId, value.stored.value.revision.revisionId, value.state, value.stored.value.file.createdAt])
        await auditReference(value, 'reference_file.allocate')
      }
      const retentionSnapshot = this.retentionSnapshot
      const session: AllocationSession = {
        read,
        create: (value) => withClientTransaction(client, () => insertAllocation(value)),
        ...(retentionSnapshot ? { createWithRetention: (build: (durationSeconds: number) => FileAllocation) =>
          withClientTransaction(client, async () => {
            check()
            const duration = await retentionSnapshot(client, ownerPrincipalId)
            const value = build(duration)
            await insertAllocation(value)
            return value
          }) } : {}),
        setState: async (state) => {
          check()
          await withClientTransaction(client, async () => {
            await mutation?.authorize(client)
            const current = await read()
            if (!current) throw new DomainError('FILE_UPLOAD_NOT_FOUND', 'Upload was not found.', 404)
            const f = current.stored.value.file
            if (state === 'canceled') {
              if (current.state === 'finalized' || f.state === 'ready') throw new DomainError('FILE_ALREADY_FINALIZED', 'Only unsent staging can be canceled.', 409)
              await client.query("update files set state='removed' where file_id=$1 and state in ('pending','expired','removed')", [f.fileId])
            } else {
              if (current.state === 'canceled' || f.state === 'removed') throw new DomainError('FILE_UPLOAD_CANCELED', 'Upload was canceled.', 409)
              const result = await client.query(`update files set state=$2 where file_id=$1 and state in ('pending','ready')
                and ((scope_kind in ('temporary','job_execution') and expires_at>clock_timestamp())
                  or scope_kind in ('workflow_reference','workspace_reference')) returning file_id`, [f.fileId, state === 'finalized' ? 'ready' : f.state])
              if (!result.rowCount) throw new DomainError('expiresAt' in f ? 'FILE_EXPIRED' : 'FILE_BYTES_UNAVAILABLE',
                'The file expired or was removed during publication.', 410)
              if (current.state === 'finalized' && state !== 'finalized') throw new DomainError('FILE_ALREADY_FINALIZED', 'The upload is already finalized.', 409)
            }
            await client.query('update file_allocations set state=$3 where owner_principal_id=$1 and request_id=$2', [ownerPrincipalId, requestId, state])
            if (state === 'finalized' && current.state !== 'finalized') await auditReference(current, 'reference_file.add')
            if (state === 'canceled' && current.state !== 'canceled') await auditReference(current, 'reference_file.cancel')
          })
          return (await read())!
        },
      }
      return await operation(session)
    } finally {
      if (locked && !broken) {
        try { await client.query('select pg_advisory_unlock(hashtextextended($1,273601))', [lockKey]) }
        catch (error) {
          broken = true
          ignoreError('db', 'release file allocation lock', { ownerPrincipalId, requestId })(error)
        }
      }
      client.removeListener('error', onError)
      client.release(broken)
    }
  }
}
