import { errorMessage } from '../../shared/errorMessage.js'
import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../infrastructure/transaction.js'
import pg from 'pg'
import { WorkspaceSchema } from '@foreman-code/contracts'
import { type ManagementAction, type ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  WorkspaceRepositoryAddInputSchema, WorkspaceRepositoryGetInputSchema, WorkspaceRepositoryReadResultSchema,
  type WorkspaceRepositoryAddInput, type WorkspaceRepositoryReadResult,
} from '@foreman-code/contracts/workspace-git'
import type { SourceRootReference } from '@foreman-code/contracts/worktree-settings'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { authorizeSource } from '../sources/authority.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { PostgresSourceService } from '../sources/service.js'
import type { WorkspaceBoundLocationService } from '../workspace-roots/service.js'
import type { WorkspaceManagementService } from './management.js'
import { workspaceStorageRoot } from './storage.js'
import { OwnedRepositoryPreparation, repositoryProjectPath } from './repositoryPreparation.js'
import { recoverRepositoryCommands, repositorySubcommand, repositoryRootSelection, repositoryRootBindInput } from './repositoryRecovery.js'
import { WorkspaceRepositoryJournal, type RepositoryImport, type ImportFailure } from './repositoryJournal.js'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK } from './projectFolderCleanup.js'

type Sql = Pick<pg.PoolClient, 'query'>
type Transport = 'http' | 'mcp'
export const REPOSITORY_READ_ACTIONS: readonly ManagementAction[] = [
  'workspaces:read', 'workspace_locations:read', 'sources:read', 'source_roots:read',
]
export const REPOSITORY_ADD_ACTIONS: readonly ManagementAction[] = [
  ...REPOSITORY_READ_ACTIONS, 'workspaces:update', 'workspace_locations:provision',
  'workspace_locations:update', 'workspace_locations:validate', 'sources:approve', 'source_roots:bind',
]
interface WorkspaceRow { record: unknown; revision: string; location_revision: string; archived_at: Date | null }

function importFailure(error: unknown): ImportFailure {
  const candidate = error instanceof DomainError ? error.code : (error as { code?: unknown } | null)?.code
  const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(candidate)
    ? candidate : 'INTERNAL_ERROR'
  const conflict = /CONFLICT|CHANGED|REVISION|PENDING|EEXIST/u.test(code)
  const unsupported = code !== 'SOURCE_GIT_CACHE_CAPACITY'
    && /UNSUPPORTED|SENSITIVE|SECRET|INVALID|INCLUSION|COLLISION|SOURCE_CAPTURE_FAILED|CAPACITY/u.test(code)
  const newCommandRequired = conflict || unsupported
    || error instanceof DomainError && error.details?.newCommandRequired === true
  return { code, message: errorMessage(error, 'Repository preparation failed.'),
    retryable: !newCommandRequired, newCommandRequired }
}

export class WorkspaceRepositoryService {
  private readonly journal: WorkspaceRepositoryJournal
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly workspaces: WorkspaceManagementService, private readonly locations: WorkspaceBoundLocationService,
    private readonly roots: WorkspaceRootPolicyPort, readonly sources: PostgresSourceService,
    private readonly mainId: string, private readonly appStorageRoot = workspaceStorageRoot()) {
    this.journal = new WorkspaceRepositoryJournal(pool)
  }

  private async transaction<T>(work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work)
  }

  private async authorize(sql: Sql, principal: ManagementPrincipal, workspaceId: string,
    actions: readonly ManagementAction[]): Promise<WorkspaceRow> {
    for (const action of actions) requireAuthorization(principal, action, { workspaceId })
    const live = await readLiveManagementPrincipal(sql, principal.id)
    for (const action of actions) requireAuthorization(live, action, { workspaceId })
    await authorizeSource(sql, principal, 'sources:read', workspaceId)
    const main = (await sql.query<{ id: string }>(
      'select id from application_installation where singleton=true for share')).rows[0]
    if (main?.id !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Repository imports belong to Main.', 403)
    const workspace = (await sql.query<WorkspaceRow>(
      'select record,revision,location_revision,archived_at from workspaces where id=$1 for share', [workspaceId])).rows[0]
    if (!workspace) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404)
    if (workspace.archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot prepare repositories.', 409)
    return workspace
  }

  private async reserve(principal: ManagementPrincipal, input: WorkspaceRepositoryAddInput): Promise<RepositoryImport> {
    return this.transaction(async sql => {
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
      const workspace = await this.authorize(sql, principal, input.workspaceId, REPOSITORY_ADD_ACTIONS)
      const existing = await this.journal.find(sql, input.workspaceId, { principalId: principal.id, commandId: input.commandId })
      if (existing) {
        this.journal.assertRetry(existing, input)
        return existing
      }
      const reused = await sql.query('select 1 from workspace_repository_imports where principal_id=$1 and command_id=$2',
        [principal.id, input.commandId])
      if (reused.rows.length) throw new DomainError('COMMAND_ID_CONFLICT', 'This import command belongs to another workspace.', 409)
      if (Number(workspace.revision) !== input.expectedRevision) {
        throw new DomainError('REVISION_CONFLICT', 'The workspace changed since it was read.', 409)
      }
      const root = await this.roots.authorize(sql, principal, { workspaceId: input.workspaceId,
        hostRef: { kind: 'main', mainId: this.mainId }, allowedBaseId: input.allowedBaseId,
        configurationRevision: input.configurationRevision, relativePath: '', accessMode: 'read-write',
        expectedLocationRevision: input.expectedLocationRevision, expectedRootPolicyRevision: input.expectedRootPolicyRevision })
      const base = root.allowlist.bases.find(item => item.baseId === input.allowedBaseId)
      if (!base || base.canonicalPath !== this.appStorageRoot || root.registration !== null) {
        throw new DomainError('REPOSITORY_BASE_UNSUPPORTED', 'Prepare repositories in Main’s app-managed Workspaces folder.', 409)
      }
      const binding = (await sql.query<{ revision: string }>(`select c.current_binding_revision as revision
        from source_root_catalog c join source_root_bindings b
        on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
        join workspace_root_policy_heads h on h.root_policy_id::text=b.record->'selection'->>'rootPolicyId'
        where c.workspace_id=$1 and h.host_scope=$2`, [input.workspaceId, `main:${this.mainId}`])).rows[0]
      if (Number(binding?.revision ?? 0) !== input.expectedBindingRevision) {
        throw new DomainError('SOURCE_ROOT_REVISION_CONFLICT', 'The source root changed since it was read.', 409)
      }
      return this.journal.reserve(sql, principal.id, input, { basePath: base.canonicalPath, baseIdentity: base.filesystem })
    })
  }

  private async revalidate(principal: ManagementPrincipal, attempt: RepositoryImport, sql?: Sql): Promise<void> {
    const check = async (sql: Sql) => {
      const row = await this.authorize(sql, principal, attempt.input.workspaceId, REPOSITORY_ADD_ACTIONS)
      const workspace = WorkspaceSchema.parse(row.record)
      if (attempt.results.workspace) {
        if (!isDeepStrictEqual(workspace.repository, attempt.input.repository)) {
          throw new DomainError('SOURCE_REPOSITORY_CHANGED', 'The workspace repository changed during preparation.', 409)
        }
      } else if (Number(row.revision) !== attempt.input.expectedRevision) {
        throw new DomainError('REVISION_CONFLICT', 'The workspace changed during preparation.', 409)
      }
      const location = attempt.results.location
      if (Number(row.location_revision) !== (location?.locationRevision ?? attempt.input.expectedLocationRevision)) {
        throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed during preparation.', 409)
      }
      if (location?.evidence === 'bound') await this.roots.resolve(sql, principal, location.binding)
      else await this.roots.authorize(sql, principal, repositoryRootSelection(attempt, this.mainId))
    }
    if (sql) await check(sql)
    else await this.transaction(check)
  }

  async add(principal: ManagementPrincipal, source: Transport, raw: unknown) {
    const input = WorkspaceRepositoryAddInputSchema.parse(raw)
    const ownership = new pg.Client({ ...this.pool.options, application_name: 'workspace-repository-import' })
    const lock = `workspace-repository:${input.workspaceId}`
    let connected = false
    let locked = false
    let attempt: RepositoryImport | undefined
    try {
      const result = await this.commands.execute({ principal, source, operation: 'workspace.repository.add',
        commandId: input.commandId, targetKey: `workspace:${input.workspaceId}:repository`, payload: input,
        authorize: async sql => {
          await this.authorize(sql, principal, input.workspaceId, REPOSITORY_ADD_ACTIONS)
          if (attempt) await this.revalidate(principal, attempt, sql)
        },
        prepare: async () => {
          await ownership.connect()
          connected = true
          const owned = (await ownership.query<{ owned: boolean }>(
            'select pg_try_advisory_lock(hashtext($1)) as owned', [lock])).rows[0]
          if (!owned?.owned) throw new DomainError('REPOSITORY_IMPORT_PENDING', 'Another repository import is running.', 409)
          locked = true
          attempt = await this.reserve(principal, input)
          await recoverRepositoryCommands(this.pool, attempt, this.mainId)
          attempt.failure = null
          await this.journal.save(attempt)
          await this.revalidate(principal, attempt)
          await this.complete(principal, source, attempt)
        },
        perform: async sql => {
          if (!attempt) throw new DomainError('REPOSITORY_IMPORT_UNCERTAIN', 'Repository preparation is unavailable.', 409)
          const value = await this.project(sql, principal, input.workspaceId, attempt, 'ready')
          if (value.state !== 'ready') throw new DomainError('REPOSITORY_IMPORT_CONFLICT', 'Repository configuration changed.', 409)
          attempt.phase = 'ready'
          attempt.failure = null
          await this.journal.save(attempt, sql)
          return { ...value, operation: { ...value.operation!, phase: 'ready' as const } }
        },
      })
      return { ...result, value: await this.get(principal, source, { workspaceId: input.workspaceId, commandId: input.commandId }) }
    } catch (error) {
      if (attempt) {
        attempt.failure = importFailure(error)
        await this.journal.save(attempt)
      }
      throw error
    } finally {
      try {
        if (locked) await ownership.query('select pg_advisory_unlock(hashtext($1))', [lock])
      } finally {
        if (connected) await ownership.end()
      }
    }
  }

  private async complete(principal: ManagementPrincipal, source: Transport, attempt: RepositoryImport): Promise<void> {
    const input = attempt.input
    const preparation = new OwnedRepositoryPreparation(this.sources.git)
    const repository = `${input.repository.owner}/${input.repository.name}`
    if (!attempt.results.workspace) {
      await preparation.prepare(attempt.preparation, repository, input.repository.defaultBranch, async value => {
        attempt.preparation = value
        if (value.commit) attempt.phase = 'cloned'
        await this.journal.save(attempt)
      })
      attempt.phase = 'published'
      await this.journal.save(attempt)
      await this.revalidate(principal, attempt)
      attempt.results.workspace = (await this.workspaces.update(principal, source, {
        workspaceId: input.workspaceId, commandId: repositorySubcommand(input, 'metadata'),
        expectedRevision: input.expectedRevision, repository: input.repository,
      })).value
      attempt.phase = 'metadata'
      await this.journal.save(attempt)
    }
    await preparation.verifyPublished(attempt.preparation, repository)
    await this.revalidate(principal, attempt)
    if (!attempt.results.location) {
      attempt.results.location = (await this.locations.set(principal, source,
        { ...repositoryRootSelection(attempt, this.mainId), commandId: repositorySubcommand(input, 'location') })).value
      attempt.phase = 'location'
      await this.journal.save(attempt)
    }
    const location = attempt.results.location
    if (location.evidence !== 'bound') throw new DomainError('REPOSITORY_LOCATION_CONFLICT', 'The prepared location is unbound.', 409)
    await this.revalidate(principal, attempt)
    if (!attempt.results.approvedSource) {
      attempt.results.approvedSource = await this.sources.approveProject(principal, {
        workspaceId: input.workspaceId, commandId: repositorySubcommand(input, 'approved'), commit: attempt.preparation.commit!,
      }, { source, preparedRepository: { repository, clone: repositoryProjectPath(attempt.preparation),
        commit: attempt.preparation.commit!, locationRevision: location.locationRevision } })
      attempt.phase = 'approved'
      await this.journal.save(attempt)
    }
    await this.revalidate(principal, attempt)
    if (!attempt.results.rootBinding) {
      const bound = (await this.sources.bindRoot(principal, source, repositoryRootBindInput(attempt))).value
      attempt.results.rootBinding = { rootId: bound.binding.rootId, bindingRevision: bound.binding.bindingRevision }
      attempt.phase = 'bound'
      await this.journal.save(attempt)
    }
    await this.revalidate(principal, attempt)
  }

  private async project(sql: Sql, principal: ManagementPrincipal, workspaceId: string,
    attempt?: RepositoryImport, state?: 'ready'): Promise<WorkspaceRepositoryReadResult> {
    const row = await this.authorize(sql, principal, workspaceId, REPOSITORY_READ_ACTIONS)
    const workspace = WorkspaceSchema.parse(row.record)
    const base = { workspaceId, repository: workspace.repository ?? null, revision: Number(row.revision) }
    if (!attempt) return WorkspaceRepositoryReadResultSchema.parse({ ...base,
      state: workspace.repository ? 'metadata-only' : 'unconfigured' })
    const results = attempt.results
    const operation = { commandId: attempt.input.commandId, phase: attempt.phase,
      ...(principal.id === attempt.principalId ? { retryInput: attempt.input } : {}),
      ...(attempt.preparation.commit ? { commit: attempt.preparation.commit } : {}),
      ...(attempt.failure ? { failure: attempt.failure } : {}) }
    const ready = state === 'ready' || attempt.phase === 'ready'
    const invalidated = ready && (!isDeepStrictEqual(workspace.repository, attempt.input.repository)
      || Number(row.location_revision) !== results.location?.locationRevision)
    const projection = { ...base, operation, location: results.location,
      approvedSource: results.approvedSource, rootBinding: results.rootBinding }
    if (invalidated) return WorkspaceRepositoryReadResultSchema.parse({ ...projection, state: 'conflict' })
    if (ready && results.location?.evidence === 'bound' && results.approvedSource && results.rootBinding) {
      try {
        await this.roots.resolve(sql, principal, results.location.binding)
        const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId, ...results.rootBinding,
          source: { approvedSourceId: results.approvedSource.manifest.approvedSourceId,
            snapshotId: results.approvedSource.manifest.snapshotId, manifestDigest: results.approvedSource.manifest.manifestDigest } })
        const current = (await sql.query<{ revision: string }>(
          'select current_binding_revision as revision from source_root_catalog where root_id=$1 for share',
          [root.binding.rootId])).rows[0]
        if (Number(current?.revision) !== root.binding.bindingRevision) {
          throw new DomainError('SOURCE_ROOT_REVISION_CONFLICT', 'The prepared source root binding changed.', 409)
        }
        await this.sources.resolveApprovedSource(sql, principal, workspaceId, results.approvedSource.manifest)
      } catch (error) {
        if (!(error instanceof DomainError) || error.status === 403) throw error
        return WorkspaceRepositoryReadResultSchema.parse({ ...projection, state: 'conflict',
          operation: { ...operation, failure: importFailure(error) } })
      }
      return WorkspaceRepositoryReadResultSchema.parse({ ...projection, state: 'ready' })
    }
    return WorkspaceRepositoryReadResultSchema.parse({ ...projection, state: attempt.failure ? 'failed' : 'preparing' })
  }

  async get(principal: ManagementPrincipal, _source: Transport, raw: unknown): Promise<WorkspaceRepositoryReadResult> {
    const input = WorkspaceRepositoryGetInputSchema.parse(raw)
    return this.transaction(async sql => {
      await this.authorize(sql, principal, input.workspaceId, REPOSITORY_READ_ACTIONS)
      const attempt = await this.journal.find(sql, input.workspaceId,
        input.commandId ? { principalId: principal.id, commandId: input.commandId } : undefined)
      return this.project(sql, principal, input.workspaceId, attempt)
    })
  }

  async readyRoot(principal: ManagementPrincipal, workspaceId: string, sql: pg.PoolClient): Promise<SourceRootReference | undefined> {
    const attempt = await this.journal.findReady(sql, workspaceId)
    if (!attempt || attempt.phase !== 'ready') return undefined
    const row = (await sql.query<WorkspaceRow>(
      'select record,revision,location_revision,archived_at from workspaces where id=$1 for share', [workspaceId])).rows[0]
    if (!row || row.archived_at || !isDeepStrictEqual(WorkspaceSchema.parse(row.record).repository, attempt.input.repository)
      || Number(row.location_revision) !== attempt.results.location?.locationRevision) return undefined
    const result = await this.project(sql, principal, workspaceId, attempt)
    return result.state === 'ready' ? result.rootBinding : undefined
  }
}
