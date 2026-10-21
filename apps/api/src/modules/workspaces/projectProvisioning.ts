import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import pg from 'pg'

import { DomainError } from '../errors.js'
import { renameDirectory } from './renameDirectory.js'

interface FolderIdentity { device: string; inode: string }
interface ProvisioningRow {
  id: string
  principal_id: string
  command_id: string
  workspace_id: string
  root_path: string
  staging_path: string
  identity: FolderIdentity | null
}

async function details(path: string) {
  try { return await lstat(path, { bigint: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Journal writes commit independently before a directory gets its public name. */
export class WorkspaceProjectProvisioning {
  private readonly journal: pg.Client

  constructor(pool: pg.Pool) {
    // A separate connection avoids waiting on the pool while the command owns its last client.
    this.journal = new pg.Client({ ...pool.options, application_name: 'graphql-project-provisioning' })
  }

  async connect() { await this.journal.connect() }
  async close() { await this.journal.end() }
  async complete(principalId: string, commandId: string) {
    await this.journal.query('delete from workspace_project_provisioning where principal_id=$1 and command_id=$2',
      [principalId, commandId])
  }

  async create(rootPath: string, owner: { principalId: string; commandId: string; workspaceId: string }) {
    const id = randomUUID()
    const stagingPath = join(dirname(rootPath), `.graphql-project-${id}`)
    await this.journal.query(`insert into workspace_project_provisioning
      (id, principal_id, command_id, workspace_id, root_path, staging_path)
      values ($1, $2, $3, $4, $5, $6)`,
    [id, owner.principalId, owner.commandId, owner.workspaceId, rootPath, stagingPath])
    await mkdir(stagingPath, { mode: 0o700 })
    const identity = await lstat(stagingPath, { bigint: true })
    await this.journal.query('update workspace_project_provisioning set identity=$2::jsonb where id=$1',
      [id, JSON.stringify({ device: String(identity.dev), inode: String(identity.ino) })])
    if (!await renameDirectory(stagingPath, rootPath)) {
      await this.remove(stagingPath, { device: String(identity.dev), inode: String(identity.ino) })
      await this.journal.query('delete from workspace_project_provisioning where id=$1', [id])
      throw new DomainError('WORKSPACE_FOLDER_EXISTS',
        'A folder with this name already exists. Choose another name or location.', 409)
    }
  }

  /** Caller holds the project-folder lifecycle lock until its transaction ends. */
  async reconcile(client: pg.PoolClient, parentPath: string) {
    if (!await details(parentPath)) return
    const canonicalParent = await realpath(parentPath)
    const pending = await this.journal.query<ProvisioningRow>('select * from workspace_project_provisioning order by created_at')
    for (const attempt of pending.rows) {
      if (dirname(attempt.root_path) !== canonicalParent) continue
      const committed = await client.query(`select 1 from workspaces
        where execution_location->>'rootPath'=$1 or created_project_folder->>'rootPath'=$1
        union all select 1 from management_command_receipts
        where principal_id=$2 and operation='workspace.create' and command_id=$3
          and result->'workspace'->>'id'=$4 limit 1`,
      [attempt.root_path, attempt.principal_id, attempt.command_id, attempt.workspace_id])
      // No final rename can occur before identity is committed. A missing
      // identity therefore refers only to the reserved internal staging name.
      await this.remove(attempt.staging_path, attempt.identity)
      // Removing the stage settles a surviving rename: it either published the
      // owned inode or no longer has a source. Recheck the destination afterward.
      if (!committed.rows.length && attempt.identity) {
        const published = await details(attempt.root_path)
        if (published && String(published.dev) === attempt.identity.device
          && String(published.ino) === attempt.identity.inode) {
          await this.remove(attempt.root_path, attempt.identity)
        }
      }
      await this.journal.query('delete from workspace_project_provisioning where id=$1', [attempt.id])
    }
  }

  private async remove(path: string, identity: FolderIdentity | null) {
    try {
      const current = await details(path)
      if (!current) return
      if (!current.isDirectory() || await realpath(path) !== path
        || identity && (String(current.dev) !== identity.device || String(current.ino) !== identity.inode)
        || !identity && current.uid !== BigInt(process.getuid!())) {
        throw new Error('The provisioned directory was replaced; it was not removed.')
      }
      // Preserve content added outside provisioning, including after a process crash.
      await rmdir(path)
    } catch (error) {
      // Publication can move the stage between inspection and removal.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
