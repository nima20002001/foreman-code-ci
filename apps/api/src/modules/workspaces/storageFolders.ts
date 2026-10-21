import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type pg from 'pg'
import {
  WorkspaceStorageFolderDeleteInputSchema, WorkspaceStorageFoldersListInputSchema,
  type ManagementPrincipal, type WorkspaceStorageFolder, type WorkspaceStorageFolderDeleteInput,
} from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { pathsOverlap } from './filesystem.js'
import { activeAgentChatDirectories } from '../conversations/activeAgentChats.js'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK, continuingRunDirectories } from './projectFolderCleanup.js'
import { lockWorkspaceFolders } from './folderLocks.js'
import { withGitDirectoryDependencies } from './gitDirectoryDependencies.js'

function identity(details: { dev: bigint; ino: bigint }): string {
  return 'sha256:' + createHash('sha256').update(`${details.dev}:${details.ino}`).digest('hex')
}

type FolderReference = { path: string; kind: 'workspace' | 'archived_workspace' | 'owned_folder' | 'active_run' | 'defaults'; registered: boolean }
const protectionMessages: Record<FolderReference['kind'], string> = {
  workspace: 'This folder overlaps a registered workspace. Remove that workspace through its own action.',
  archived_workspace: 'An archived workspace still references this folder. Its retained location is protected.',
  owned_folder: 'A workspace owns or is preparing this project folder. Finish preparation before removing the workspace.',
  active_run: 'An active run uses this folder. Settle active work before deleting it.',
  defaults: 'Workspace defaults use this folder. Choose another default destination before deleting it.',
}
function deletionState(path: string, rootPath: string, references: FolderReference[]): WorkspaceStorageFolder['deletion'] {
  const reference = references.find((item) => !(item.kind === 'defaults' && item.path === rootPath) && pathsOverlap(path, item.path))
  return reference ? { status: 'protected', reason: reference.kind, message: protectionMessages[reference.kind] } : { status: 'available' }
}

/** Discovery never registers records or confers ownership of existing content. */
export class WorkspaceStorageFolders {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator, private readonly root: string, private readonly runnerId = 'runner-local') {}

  private async rootPath() {
    try { return await realpath(this.root) } catch {
      throw new DomainError('DIRECTORY_ROOT_UNAVAILABLE', 'The app’s Workspaces location is unavailable.', 503)
    }
  }

  private async references(client: pg.Pool | pg.PoolClient) {
    const result = await client.query<FolderReference>(`
      select execution_location->>'rootPath' as path,
        case when archived_at is null then 'workspace' else 'archived_workspace' end as kind,
        archived_at is null as registered from workspaces where execution_location->>'runnerId'=$1
      union all select created_project_folder->>'rootPath', 'owned_folder', false from workspaces where created_project_folder->>'runnerId'=$1
      union all select (preparation->>'basePath') || '/' || (preparation->>'directoryName'), 'owned_folder', false
        from workspace_repository_imports where finished_at is null
      union all select record->>'parentPath', 'defaults', false from application_settings where record->>'parentPath' is not null
    `, [this.runnerId])
    const directories = [
      ...await continuingRunDirectories(client, this.runnerId),
      ...await activeAgentChatDirectories(client),
    ]
    const references = result.rows.filter(({ path }) => Boolean(path))
    const dependencies: FolderReference[] = []
    for (const reference of references) {
      if (reference.kind === 'defaults') continue
      const paths = await withGitDirectoryDependencies([reference.path])
      dependencies.push(...paths.filter(path => path !== reference.path)
        .map(path => ({ path, kind: reference.kind, registered: false })))
    }
    return [...references, ...dependencies,
      ...directories.map(path => ({ path, kind: 'active_run' as const, registered: false }))]
  }

  async list(principal: ManagementPrincipal, raw: { cursor?: string | undefined; limit?: number | undefined }) {
    requireAuthorization(principal, 'workspaces:read')
    requireAuthorization(principal, 'workspace_locations:read')
    const input = WorkspaceStorageFoldersListInputSchema.parse(raw)
    const rootPath = await this.rootPath()
    const references = await this.references(this.pool)
    const entries = (await readdir(rootPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && (!input.cursor || entry.name > input.cursor))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const items: WorkspaceStorageFolder[] = []
    for (const entry of entries) {
      const path = resolve(rootPath, entry.name)
      // Only the exact destination already represented by an active workspace card is duplicated.
      if (references.some((reference) => reference.registered && reference.path === path)) continue
      try {
        const details = await lstat(path, { bigint: true })
        if (!details.isDirectory() || await realpath(path) !== path) continue
        items.push({ name: entry.name, path, identity: identity(details), deletion: deletionState(path, rootPath, references) })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (items.length > input.limit) break
    }
    const page = items.slice(0, input.limit)
    return { rootPath, items: page, pageInfo: { nextCursor: items.length > input.limit ? page.at(-1)!.name : null } }
  }

  async delete(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: WorkspaceStorageFolderDeleteInput) {
    requireAuthorization(principal, 'workspaces:archive')
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const input = WorkspaceStorageFolderDeleteInputSchema.parse(raw)
    return this.commands.execute({
      principal, source, operation: 'workspace.storage_folder.delete', commandId: input.commandId,
      targetKey: `workspace-folder:${input.path}`, payload: input,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        const rootPath = await this.rootPath()
        if (dirname(input.path) !== rootPath || resolve(input.path) !== input.path) {
          throw new DomainError('DIRECTORY_OUTSIDE_ROOT', 'Only direct workspace folders inside the app’s Workspaces location can be deleted.', 403)
        }
        await lockWorkspaceFolders(client, [input.path])
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${input.path}`])
        const references = await this.references(client)
        const deletion = deletionState(input.path, rootPath, references)
        if (deletion.status === 'protected') {
          throw new DomainError('DIRECTORY_IN_USE', deletion.message, 409, { reason: deletion.reason })
        }
        let details
        try { details = await lstat(input.path, { bigint: true }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        // A failed receipt commit can be retried after removal; never touch a replacement.
        if (details) {
          if (!details.isDirectory() || await realpath(input.path) !== input.path || identity(details) !== input.expectedIdentity) {
            throw new DomainError('DIRECTORY_CHANGED', 'This folder has been replaced or moved. Reload the list before deleting.', 409)
          }
          await rm(input.path, { recursive: true, force: true })
        }
        return { path: input.path }
      },
    })
  }
}
