import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import {
  WorkspaceRepositoryAddInputSchema, WorkspaceRepositoryImportPhaseSchema,
  WorkspaceRepositoryImportOperationSchema, type WorkspaceRepositoryAddInput,
} from '@foreman-code/contracts/workspace-git'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { WorkspaceBoundLocationReadbackSchema } from '@foreman-code/contracts/workspace-bound-location'
import { RootFilesystemIdentitySchema } from '@foreman-code/contracts/workspace-root-policies'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { SourceManifestSchema } from '@foreman-code/contracts/source-materialization'
import { SourceRootReferenceSchema } from '@foreman-code/contracts/worktree-settings'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { RepositoryPreparation } from './repositoryPreparation.js'

const PreparationSchema = z.object({
  importId: z.uuid(), basePath: z.string().startsWith('/'), baseIdentity: RootFilesystemIdentitySchema,
  directoryName: z.string().regex(/^repository-[a-f0-9]{16}-[a-f0-9-]{36}$/u),
  containerIdentity: RootFilesystemIdentitySchema.optional(), cloneIdentity: RootFilesystemIdentitySchema.optional(),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).optional(),
  manifest: SourceManifestSchema.optional(),
}).strict()
const ResultsSchema = z.object({
  workspace: ManagedWorkspaceSchema.optional(), location: WorkspaceBoundLocationReadbackSchema.optional(),
  approvedSource: ApprovedSourceSchema.optional(), rootBinding: SourceRootReferenceSchema.optional(),
}).strict()
const FailureSchema = WorkspaceRepositoryImportOperationSchema.shape.failure.unwrap()
export type RepositoryResults = z.infer<typeof ResultsSchema>
export type ImportFailure = z.infer<typeof FailureSchema>
export type ImportPhase = z.infer<typeof WorkspaceRepositoryImportPhaseSchema>
export interface RepositoryImport {
  importId: string
  principalId: string
  input: WorkspaceRepositoryAddInput
  inputHash: string
  phase: ImportPhase
  preparation: RepositoryPreparation
  results: RepositoryResults
  failure: ImportFailure | null
}
interface ImportRow {
  import_id: string; principal_id: string; input: unknown; input_hash: string; phase: unknown
  preparation: unknown; results: unknown; failure: unknown
}
function parse(row: ImportRow): RepositoryImport {
  return { importId: row.import_id, principalId: row.principal_id,
    input: WorkspaceRepositoryAddInputSchema.parse(row.input), inputHash: row.input_hash,
    phase: WorkspaceRepositoryImportPhaseSchema.parse(row.phase), preparation: PreparationSchema.parse(row.preparation),
    results: ResultsSchema.parse(row.results), failure: row.failure ? FailureSchema.parse(row.failure) : null }
}

export class WorkspaceRepositoryJournal {
  constructor(private readonly pool: pg.Pool) {}

  async find(sql: Pick<pg.PoolClient, 'query'>, workspaceId: string,
    command?: { principalId: string; commandId: string }): Promise<RepositoryImport | undefined> {
    const result = command
      ? await sql.query<ImportRow>(`select * from workspace_repository_imports
          where workspace_id=$1 and principal_id=$2 and command_id=$3`,
        [workspaceId, command.principalId, command.commandId])
      : await sql.query<ImportRow>(`select * from workspace_repository_imports
          where workspace_id=$1 order by (finished_at is null) desc,created_at desc,import_id desc limit 1`, [workspaceId])
    return result.rows[0] ? parse(result.rows[0]) : undefined
  }

  async findReady(sql: Pick<pg.PoolClient, 'query'>, workspaceId: string): Promise<RepositoryImport | undefined> {
    const result = await sql.query<ImportRow>(`select i.* from workspace_repository_imports i join workspaces w on w.id=i.workspace_id
      where i.workspace_id=$1 and i.phase='ready' and i.input->'repository'=w.record->'repository'
        and (i.results->'location'->>'locationRevision')::bigint=w.location_revision
      order by i.created_at desc,i.import_id desc limit 1`, [workspaceId])
    return result.rows[0] ? parse(result.rows[0]) : undefined
  }

  async reserve(sql: pg.PoolClient, principalId: string, input: WorkspaceRepositoryAddInput,
    preparation: Omit<RepositoryPreparation, 'importId' | 'directoryName'>): Promise<RepositoryImport> {
    const other = await sql.query(`select 1 from workspace_repository_imports
      where workspace_id=$1 and finished_at is null`, [input.workspaceId])
    if (other.rows.length) {
      throw new DomainError('REPOSITORY_IMPORT_PENDING', 'Another repository import is unfinished. Read its progress first.', 409)
    }
    const importId = randomUUID()
    const workspaceKey = commandInputHash(input.workspaceId).slice('sha256:'.length).slice(0, 16)
    const owned = { ...preparation, importId, directoryName: `repository-${workspaceKey}-${importId}` }
    const result = await sql.query<ImportRow>(`insert into workspace_repository_imports
      (import_id,principal_id,workspace_id,command_id,input_hash,input,phase,preparation)
      values($1,$2,$3,$4,$5,$6::jsonb,'reserved',$7::jsonb) returning *`,
    [importId, principalId, input.workspaceId, input.commandId, commandInputHash(input), JSON.stringify(input),
      JSON.stringify(owned)])
    return parse(result.rows[0]!)
  }

  async save(attempt: RepositoryImport, sql: Pick<pg.PoolClient, 'query'> = this.pool): Promise<void> {
    await sql.query(`update workspace_repository_imports
      set phase=$2,preparation=$3::jsonb,results=$4::jsonb,failure=$5::jsonb,updated_at=now(),
        finished_at=case when $2='ready' or $6 then coalesce(finished_at,now()) else null end
      where import_id=$1`, [attempt.importId, attempt.phase, JSON.stringify(PreparationSchema.parse(attempt.preparation)),
      JSON.stringify(ResultsSchema.parse(attempt.results)),
      attempt.failure ? JSON.stringify(FailureSchema.parse(attempt.failure)) : null,
      attempt.failure?.newCommandRequired ?? false])
  }

  assertRetry(attempt: RepositoryImport, input: WorkspaceRepositoryAddInput): void {
    if (attempt.inputHash !== commandInputHash(input)) {
      throw new DomainError('COMMAND_ID_CONFLICT', 'This repository command was already used with different input.', 409)
    }
    if (attempt.failure?.newCommandRequired) {
      throw new DomainError(attempt.failure.code, attempt.failure.message, 409,
        { retryable: false, newCommandRequired: true })
    }
  }
}
