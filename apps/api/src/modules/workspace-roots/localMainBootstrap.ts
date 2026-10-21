import { createHash } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type pg from 'pg'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { DomainError } from '../errors.js'
import { anchored, directoryFlags, openChildDirectory, openPrivateRoot } from '../sources/privateFilesystem.js'
import { qualifyApprovedRootAllowlist, verifyApprovedRootAllowlist } from '../sources/rootAttestation.js'
import { sourceSha256 } from '../sources/manifest.js'
import { workspaceRootHostScope, type PostgresWorkspaceRootPolicies } from '../sources/rootPolicies.js'
import { workspaceStorageRoot } from '../workspaces/storage.js'
import { pathsOverlap } from '../workspaces/filesystem.js'

function storageBaseId(mainId: string, storageRoot: string): string {
  const bytes = createHash('sha256').update(`graphql:main-workspace-storage:v1:${mainId}:${storageRoot}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function initializePrivateStorage(storageRoot: string): Promise<void> {
  try {
    const root = await openPrivateRoot(storageRoot)
    await root.close()
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'SOURCE_ROOT_NOT_PRIVATE') throw error
  }
  // Establish the application's own private directory through its protected
  // parent. Never follow a symlink or change permissions on a user project.
  await mkdir(dirname(storageRoot), { recursive: true, mode: 0o700 })
  const parent = await openPrivateRoot(dirname(storageRoot))
  try {
    const leaf = storageRoot.slice(dirname(storageRoot).length + 1)
    try { await mkdir(anchored(parent, leaf), { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    // Existing app storage may predate private-root initialization. Parent
    // protection and leaf ownership are checked before tightening its mode.
    const root = await open(anchored(parent, leaf), directoryFlags)
    try {
      if ((await root.stat()).uid !== process.getuid?.()) throw new DomainError('ROOT_ACCESS_DENIED', 'App storage must be owned by Main.', 403)
      await root.chmod(0o700)
      await root.sync()
    } finally { await root.close() }
    const verified = await openChildDirectory(parent, leaf)
    await verified.close()
  } finally { await parent.close() }
}

/** Trusted installation composition only. App-managed storage is already the
 * local workspace provisioning boundary; defaults and browser/MCP paths never
 * enter this bootstrap. Other Main/device roots still require owner approval.
 * The optional root is ApiConfig's isolated, server-owned composition override.
 */
export async function bootstrapLocalMainWorkspaceRoot(input: {
  pool: pg.Pool; policies: PostgresWorkspaceRootPolicies; mainId: string; runtimeRoot: string; appStorageRoot?: string
}) {
  const storageRoot = input.appStorageRoot ?? workspaceStorageRoot()
  const runtimeRoot = resolve(input.runtimeRoot), hostRef = { kind: 'main' as const, mainId: input.mainId }
  if (resolve(storageRoot) !== storageRoot || pathsOverlap(storageRoot, runtimeRoot)) {
    throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'App-managed workspace storage must be canonical and separate from harness runtime.', 409)
  }
  const baseId = storageBaseId(input.mainId, storageRoot)
  return withTransaction(input.pool, async (sql) => {
    const main = (await sql.query<{ id: string }>('select id from application_installation where singleton=true for share')).rows[0]
    if (main?.id !== input.mainId) throw new DomainError('ROOT_WRONG_MAIN', 'Workspace storage belongs to the actual Main installation.', 403)
    const hostScope = workspaceRootHostScope(hostRef)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`root-configuration:${hostScope}`])
    const current = (await sql.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
      join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
      where h.host_scope=$1 for share of h,c`, [hostScope])).rows[0]
    if (current) {
      const approved = ApprovedRootAllowlistSchema.parse(current.record)
      // A restart cannot refresh an accepted filesystem identity or replace an
      // explicit owner-approved configuration with our automatic storage root.
      if (approved.bases.some(base => base.baseId === baseId)) {
        if (approved.applicationInstallationId !== input.mainId || approved.hostRef.kind !== 'main'
          || approved.hostRef.mainId !== input.mainId || approved.managedRuntimeRoot !== runtimeRoot
          || approved.bases.length !== 1 || approved.bases[0]!.canonicalPath !== storageRoot) {
          throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'The accepted app-managed workspace configuration changed.', 409)
        }
        await verifyApprovedRootAllowlist(approved)
      }
      return approved
    }
    await initializePrivateStorage(storageRoot)
    const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef, applicationInstallationId: input.mainId,
      configurationRevision: '1', bases: [{ baseId, canonicalPath: storageRoot, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtimeRoot })
    await input.policies.publishApprovedHostConfiguration(sql, approved, { mainId: input.mainId, hostRef,
      applicationInstallationId: input.mainId, configurationRevision: approved.configurationRevision,
      configurationDigest: sourceSha256(Buffer.from(JSON.stringify(approved))) })
    return approved
  })
}
