import { homedir } from 'node:os'
import { errorMessage } from '../../shared/errorMessage.js'
import type pg from 'pg'
import { mkdir, opendir, readdir, realpath, rename, rmdir, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { WorkspaceFolderUndoInputSchema, type WorkspaceFolderUndoInput, WorkspaceFolderCreateInputSchema, WorkspaceFolderCreateResultSchema, WorkspaceFolderRenameInputSchema, type WorkspaceFolderRenameInput, type WorkspaceFolderCreateInput, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { WorkspaceFolderDeleteInputSchema, type WorkspaceFolderDeleteInput } from '@foreman-code/contracts/management'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK, continuingRunDirectories } from '../workspaces/projectFolderCleanup.js'
import { pathsOverlap } from '../workspaces/filesystem.js'
import { activeAgentChatDirectories } from '../conversations/activeAgentChats.js'
import { lockWorkspaceFolders } from '../workspaces/folderLocks.js'

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Selection follows filesystem access; deletion stays inside configured storage roots. */
export class HarnessDirectoryBrowser {
  constructor(private readonly configuredRoots: readonly string[], private readonly pool: pg.Pool) {}

  private async assertFolderUnused(client: pg.PoolClient, path: string) {
    const references = await client.query("select id from workspaces where execution_location->>'rootPath'=$1", [path])
    const defaults = await client.query("select key from application_settings where record->>'parentPath'=$1", [path])
    if (references.rowCount || defaults.rowCount) {
      throw new DomainError('DIRECTORY_IN_USE', 'This folder is already used by workspace settings.', 409)
    }
    await this.assertNoUnfinishedImport(client, path)
    const directories = [
      ...await activeAgentChatDirectories(client),
      ...await continuingRunDirectories(client, 'runner-local'),
    ]
    if (directories.some(directory => pathsOverlap(path, directory))) {
      throw new DomainError('DIRECTORY_IN_USE', 'This folder is used by queued or active work or pending Run cleanup.', 409)
    }
  }

  private async assertNoUnfinishedImport(client: pg.PoolClient, path: string) {
    const imports = await client.query<{ path: string }>(`
      select (preparation->>'basePath') || '/' || (preparation->>'directoryName') as path
      from workspace_repository_imports where finished_at is null`)
    if (imports.rows.some(item => pathsOverlap(path, item.path))) {
      throw new DomainError('DIRECTORY_IN_USE', 'This folder is used by an unfinished repository import.', 409)
    }
  }

  async create(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderCreateInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderCreateInputSchema.parse(input)
    const result = await new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.create', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        let parent: string
        try { parent = await realpath(accepted.parentPath) } catch {
          throw new DomainError('DIRECTORY_UNAVAILABLE', 'The parent folder is unavailable.', 404)
        }
        if (!isAbsolute(accepted.parentPath)) {
          throw new DomainError('DIRECTORY_PATH_INVALID', 'Choose an absolute folder path.', 400)
        }
        for (let index = 1; index <= 10_000; index++) {
          const name = accepted.name ?? (index === 1 ? 'New folder' : `New folder (${index})`)
          const path = resolve(parent, name)
          await this.assertNoUnfinishedImport(client, path)
          try {
            await mkdir(path)
            const identity = await lstat(path, { bigint: true })
            return { path, name, device: String(identity.dev), inode: String(identity.ino) }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              if (!accepted.name) continue
              throw new DomainError('DIRECTORY_EXISTS', 'A folder with this name already exists. Choose another name.', 409, undefined, { cause: error })
            }
            throw new DomainError('DIRECTORY_CREATE_FAILED', 'The folder could not be created. Check the parent folder permissions.', 422, undefined, { cause: error })
          }
        }
        throw new DomainError('DIRECTORY_NAME_UNAVAILABLE', 'Choose a folder name explicitly.', 409)
      },
    })
    return { value: { path: result.value.path, name: result.value.name }, replayed: result.replayed }
  }

  async renameCreated(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderRenameInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderRenameInputSchema.parse(input)
    const result = await new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.rename', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        let sourcePath = accepted.path
        if (accepted.creationCommandId) {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`folder-creation:${principal.id}:${accepted.creationCommandId}`])
        const receipt = await client.query<{ result: unknown }>(
          "select result from management_command_receipts where principal_id=$1 and operation='workspace.folder.create' and command_id=$2",
          [principal.id, accepted.creationCommandId],
        )
        if (!receipt.rows[0]) throw new DomainError('DIRECTORY_CREATION_REQUIRED', 'Only a folder created by this caller can be renamed here.', 403)
        const created = WorkspaceFolderCreateResultSchema.shape.value.strip().parse(receipt.rows[0].result)
        const previous = await client.query<{ operation: string; result: { path: string } }>("select operation, result from management_command_receipts where principal_id=$1 and operation in ('workspace.folder.rename', 'workspace.folder.undo') and result->>'creationCommandId'=$2 order by created_at desc limit 1",
          [principal.id, accepted.creationCommandId])
        if (previous.rows[0]?.operation === 'workspace.folder.undo') throw new DomainError('DIRECTORY_ALREADY_UNDONE', 'Folder creation has been undone.', 409)
        sourcePath = previous.rows[0]?.result.path ?? created.path
        }
        const current = sourcePath && await realpath(sourcePath).catch(ignoreError('harness', 'resolve directory browser source', {}, ['ENOENT', 'ENOTDIR']))
        if (!current || current !== sourcePath) {
          throw new DomainError('DIRECTORY_UNAVAILABLE', 'The created folder is no longer available at its original location.', 409)
        }
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${current}`])
        const target = resolve(dirname(current), accepted.name)
        if (target === current) return { path: current, name: accepted.name, creationCommandId: accepted.creationCommandId }
        await lockWorkspaceFolders(client, [current, target])
        if ((await readdir(current)).length) throw new DomainError('DIRECTORY_NOT_EMPTY', 'Only an empty folder can be renamed here.', 409)
        await this.assertFolderUnused(client, current)
        await this.assertNoUnfinishedImport(client, target)
        try { await mkdir(target) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('DIRECTORY_EXISTS', 'A folder with this name already exists.', 409, undefined, { cause: error })
          throw new DomainError('DIRECTORY_RENAME_FAILED', 'The folder could not be renamed.', 422, undefined, { cause: error })
        }
        try { await rename(current, target) } catch {
          await rmdir(target).catch(ignoreError('harness', 'remove rename reservation', { commandId: accepted.commandId, creationCommandId: accepted.creationCommandId }))
          throw new DomainError('DIRECTORY_RENAME_FAILED', 'The folder could not be renamed.', 422)
        }
        return { path: target, name: accepted.name, creationCommandId: accepted.creationCommandId }
      },
    })
    return { value: { path: result.value.path, name: result.value.name }, replayed: result.replayed }
  }

  async undoCreated(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderUndoInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderUndoInputSchema.parse(input)
    const result = await new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.undo', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`folder-creation:${principal.id}:${accepted.creationCommandId}`])
        const receipt = await client.query<{ result: { path: string; device?: string; inode?: string } }>(
          "select result from management_command_receipts where principal_id=$1 and operation='workspace.folder.create' and command_id=$2",
          [principal.id, accepted.creationCommandId])
        const created = receipt.rows[0]?.result
        if (!created?.device || !created.inode) throw new DomainError('DIRECTORY_CREATION_REQUIRED', 'Only a new folder created by this caller can be undone.', 403)
        const undone = await client.query("select 1 from management_command_receipts where principal_id=$1 and operation='workspace.folder.undo' and result->>'creationCommandId'=$2", [principal.id, accepted.creationCommandId])
        if (undone.rowCount) throw new DomainError('DIRECTORY_ALREADY_UNDONE', 'Folder creation has already been undone.', 409)
        const named = await client.query<{ result: { path: string } }>(
          "select result from management_command_receipts where principal_id=$1 and operation='workspace.folder.rename' and result->>'creationCommandId'=$2 order by created_at desc limit 1", [principal.id, accepted.creationCommandId])
        const path = named.rows[0]?.result.path ?? created.path
        const roots = await Promise.all(this.configuredRoots.map((root) => realpath(root)))
        if (await realpath(path).catch(ignoreError('harness', 'resolve created directory', {}, ['ENOENT', 'ENOTDIR'])) !== path || !roots.some((root) => path !== root && isInside(root, path))) {
          throw new DomainError('DIRECTORY_UNAVAILABLE', 'The created folder is no longer available.', 409)
        }
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${path}`])
        await lockWorkspaceFolders(client, [path])
        const identity = await lstat(path, { bigint: true })
        if (!identity.isDirectory() || String(identity.dev) !== created.device || String(identity.ino) !== created.inode) {
          throw new DomainError('DIRECTORY_CHANGED', 'The original folder has been replaced and cannot be undone.', 409)
        }
        await this.assertFolderUnused(client, path)
        try { await rmdir(path) } catch (error) {
          if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new DomainError('DIRECTORY_NOT_EMPTY', 'This folder contains files and cannot be undone.', 409, undefined, { cause: error })
          }
          throw new DomainError('DIRECTORY_UNDO_FAILED', 'The folder could not be removed.', 422, undefined, { cause: error })
        }
        return { path, creationCommandId: accepted.creationCommandId }
      },
    })
    return { value: { path: result.value.path }, replayed: result.replayed }
  }

  async deleteFolders(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderDeleteInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderDeleteInputSchema.parse(input)
    return new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.delete', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        const roots = await Promise.all(this.configuredRoots.map((root) => realpath(root)))
        const paths = [...accepted.paths].sort()
        for (const path of paths) {
          if (!isAbsolute(path) || !roots.some((root) => path !== root && isInside(root, path))) {
            throw new DomainError('DIRECTORY_OUTSIDE_ROOT', 'Only folders inside workspace storage can be deleted.', 403)
          }
          await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${path}`])
        }
        await lockWorkspaceFolders(client, paths)
        const deleted: string[] = []
        const failed: { path: string; message: string }[] = []
        for (const path of paths) {
          try {
            if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) {
              throw new Error('This folder is no longer available at its original location.')
            }
            await this.assertFolderUnused(client, path)
            await rmdir(path)
            deleted.push(path)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            failed.push({ path, message: ['ENOTEMPTY', 'EEXIST'].includes(code ?? '')
              ? 'This folder contains files. Only empty folders can be deleted.'
              : code ? 'This folder could not be deleted.' : errorMessage(error, 'This folder could not be deleted.') })
          }
        }
        return { deleted, failed }
      },
    })
  }

  async browse(principal: ManagementPrincipal, input: {
    rootId?: string | undefined
    path?: string | undefined
    cursor?: string | undefined
  }) {
    requireAuthorization(principal, 'harnesses:read')
    requireAuthorization(principal, 'workspace_locations:read')
    const browseRoots = [...new Set([...this.configuredRoots, homedir()])]
    const roots = await Promise.all(browseRoots.map(async (path, index) => {
      let canonical: string
      try { canonical = await realpath(path) } catch { throw new DomainError('DIRECTORY_ROOT_UNAVAILABLE', 'A browse location is unavailable.', 503) }
      let label = basename(canonical) || canonical
      if (path === homedir()) label = 'Home'
      else if (this.configuredRoots.length === 1) label = 'Workspaces'
      return { id: String(index), label, path: canonical }
    }))
    const root = input.rootId ? roots.find((item) => item.id === input.rootId) : roots[0]
    if (!root) throw new DomainError('DIRECTORY_ROOT_INVALID', 'Select a browse location.', 400)
    const requested = input.path ?? root.path
    if (!isAbsolute(requested)) throw new DomainError('DIRECTORY_PATH_INVALID', 'Choose an absolute folder path.', 400)
    let path: string
    try { path = await realpath(requested) } catch { throw new DomainError('DIRECTORY_UNAVAILABLE', 'That folder is unavailable.', 404) }
    if (!(await lstat(path)).isDirectory()) throw new DomainError('DIRECTORY_REQUIRED', 'Select a folder.', 400)
    let directory
    try { directory = await opendir(path) } catch { throw new DomainError('DIRECTORY_UNAVAILABLE', 'That folder cannot be opened by this runner.', 403) }
    const candidates: { name: string; path: string }[] = []
    let scanned = 0
    let truncated = false
    for await (const entry of directory) {
      if (++scanned > 20_000) {
        truncated = true
        break
      }
      if (entry.name.startsWith('.')) continue
      const entryPath = resolve(path, entry.name)
      if (!entry.isDirectory()) {
        if (!entry.isSymbolicLink()) continue
        try {
          if (!(await lstat(await realpath(entryPath))).isDirectory()) continue
        } catch (error) {
          if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
          throw error
        }
      }
      candidates.push({ name: entry.name, path: entryPath })
    }
    candidates.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const after = candidates.filter((item) => !input.cursor || item.name > input.cursor)
    const directories = after.slice(0, 100)
    return { roots, rootId: root.id, path, parent: path === root.path ? null : dirname(path), directories,
      nextCursor: after.length > directories.length ? directories.at(-1)!.name : null, truncated }
  }
}
