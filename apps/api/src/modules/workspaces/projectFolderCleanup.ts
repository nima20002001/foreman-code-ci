import { errorMessage } from '../../shared/errorMessage.js'
import { lstat, realpath, rm } from 'node:fs/promises'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../../infrastructure/transaction.js'
import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { pathsOverlap } from './filesystem.js'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { activeAgentChatDirectories } from '../conversations/activeAgentChats.js'
import { lockWorkspaceFolders } from './folderLocks.js'
import { withGitDirectoryDependencies } from './gitDirectoryDependencies.js'

export const WORKSPACE_FOLDER_LIFECYCLE_LOCK = 'workspace-folder-lifecycle'
export const CreatedProjectFolderSchema = z.object({
  runnerId: z.string(), rootPath: z.string(),
  identity: z.object({ device: z.string(), inode: z.string() }),
})

/** Run after the archive receipt commits, including receipt replays. A failed
 * cleanup retains ownership so the same removal command can safely retry. */
export async function cleanupWorkspaceProjectFolders(pool: pg.Pool, principal: ManagementPrincipal, ids: string[], runnerId: string, source: 'http' | 'mcp', commandId: string) {
  const client = await pool.connect()
  try {
    await beginTransaction(client)
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
    const owned = await client.query<{ id: string; created_project_folder: unknown }>(
      'select id, created_project_folder from workspaces where id = any($1::text[]) and archived_at is not null and created_project_folder is not null for update', [ids],
    )
    for (const row of owned.rows) {
      requireAuthorization(principal, 'workspace_locations:provision', { workspaceId: row.id })
      const folder = CreatedProjectFolderSchema.parse(row.created_project_folder)
      if (folder.runnerId !== runnerId || !isAbsolute(folder.rootPath)) throw new Error('The project folder belongs to another runner.')
      await lockWorkspaceFolders(client, [folder.rootPath])
      const references = await client.query<{ path: string }>(
        "select record->>'parentPath' as path from application_settings where record->>'parentPath' is not null",
      )
      // A storage/default parent may contain the project; the project must not
      // contain that parent or any other workspace's execution location.
      const otherWorkspaces = await client.query<{ path: string }>(
        `select execution_location->>'rootPath' as path from workspaces where not (id = any($1::text[]))
         and archived_at is null and execution_location->>'runnerId'=$2
         union all select created_project_folder->>'rootPath' as path from workspaces
         where not (id = any($1::text[])) and created_project_folder->>'runnerId'=$2`, [ids, runnerId],
      )
      const workspaceDirectories = await withGitDirectoryDependencies(otherWorkspaces.rows.map(row => row.path))
      const runDirectories = await continuingRunDirectories(client, runnerId)
      const contains = (path: string) => { const suffix = relative(folder.rootPath, path); return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep) }
      if (references.rows.some(({ path }) => contains(path)) || workspaceDirectories.some(path => pathsOverlap(folder.rootPath, path))) {
        throw new Error('The project folder is still used by another workspace or workspace defaults.')
      }
      if (runDirectories.some(path => pathsOverlap(folder.rootPath, path))) {
        throw new Error('The project folder is still required by an accepted Run or its pending cleanup.')
      }
      const chatDirectories = await activeAgentChatDirectories(client)
      if (chatDirectories.some(path => pathsOverlap(folder.rootPath, path))) {
        throw new Error('The project folder is still required by queued or active Agent chat messages.')
      }
      let details
      try { details = await lstat(folder.rootPath, { bigint: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (details) {
        if (!details.isDirectory() || await realpath(folder.rootPath) !== folder.rootPath
          || String(details.dev) !== folder.identity.device || String(details.ino) !== folder.identity.inode) {
          throw new Error('The project folder has been replaced or moved; it was not deleted.')
        }
        await rm(folder.rootPath, { recursive: true, force: true })
      }
      await client.query('update workspaces set created_project_folder = null where id = $1', [row.id])
      await client.query(`insert into management_audit (principal_id, source, action, target_key, outcome, details)
        values ($1, $2, 'workspace.folder.cleanup', $3, 'succeeded', $4::jsonb)`,
      [principal.id, source, `workspace:${row.id}`, JSON.stringify({ commandId })])
    }
    await commitTransaction(client)
  } catch (error) {
    await rollbackTransaction(client)
    await client.query(`insert into management_audit (principal_id, source, action, target_key, outcome, details)
      values ($1, $2, 'workspace.folder.cleanup', 'workspaces:cleanup', 'failed', $3::jsonb)`,
    [principal.id, source, JSON.stringify({ commandId, workspaceIds: ids })])
      .catch(ignoreError('lifecycle', 'record failed workspace folder cleanup audit', { commandId }))
    throw new DomainError('WORKSPACE_FOLDER_CLEANUP_FAILED',
      `The workspace was archived, but its project folder could not be removed. Retry removal. ${errorMessage(error, '')}`, 503, undefined, { cause: error })
  } finally { client.release() }
}

/** Main-host project and Git paths retained by Runs, native working trees and their cleanup. */
export async function continuingRunDirectories(sql: Pick<pg.Pool, 'query'>, runnerId: string): Promise<string[]> {
  const result = await sql.query<{ path: string }>(
    `with continuing_runs as (
       select r.id, r.runner_id, r.workflow_version_id,
         coalesce(r.working_directory, r.record#>>'{executionLocation,rootPath}') as working_directory
       from runs r
       where r.execution_state in ('queued', 'running', 'waiting', 'interrupted')
         or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
     )
     select r.working_directory as path from continuing_runs r
     join workflow_versions v on v.id=r.workflow_version_id
     where r.runner_id=$1 and exists(
       select 1 from jsonb_array_elements(v.record->'definition'->'nodes') node
       where node->>'kind'='job' or not exists(
         select 1 from run_node_placements p where p.run_id=r.id and p.node_id=node->>'id'))
     union all
     select p.record#>>'{destination,canonicalProjectRoot}' as path
     from continuing_runs r join run_node_placements p on p.run_id=r.id
     where p.record#>>'{hostRef,kind}'='main'
     union all
     select n.record#>>'{workingTree,canonicalProjectRoot}' as path
     from continuing_runs r join execution_native_placements n on n.record->>'runId'=r.id
     where n.record#>'{materialization,receipt,binding,deviceId}'='null'::jsonb`, [runnerId],
  )
  return withGitDirectoryDependencies(result.rows.map(row => row.path))
}
