import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SourceRootRecordSchema, SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { jobSpec } from './helpers/jobFixture.js'
import { CanonicalJobPreparationService, CanonicalJobPreparationSources } from '../src/modules/jobs/sourcePreparation.js'
import { sourceWorkingTreePath } from '../src/modules/sources/sourceTreePaths.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'

describe.skipIf(!postgresEnabled)('queued ordinary Job source', () => {
  it('materializes the queued commit after the root head advances, while new selection requires the current head', async () => {
    const db = await currentDatabase()
    try {
      const mainId = (await db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
      const workspaceId = randomUUID()
      const { principal } = await new PostgresAccessService(db.pool).issue({ name: 'Queued source owner',
        audience: 'operator', expiresAt: new Date('2099-01-01T00:00:00Z'), grants: [] })
      const spec = jobSpec()
      const rootId = randomUUID()
      const filesystem = { device: '1', inode: '2', mountId: '3' }
      spec.target = { ...spec.target, mainId, mainInstallationId: mainId, hostRef: { kind: 'main', mainId },
        destination: { ...spec.target.destination, rootPolicyId: rootId, attestationId: randomUUID(),
          canonicalProjectRoot: join(db.directory, 'source-materializations', rootId),
          canonicalCwd: join(db.directory, 'source-materializations', rootId), managedRuntimeRoot: db.directory,
          directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(filesystem))) } }
      const root = SourceRootRecordSchema.parse({ version: 1,
        source: { approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId,
          manifestDigest: spec.source.manifestDigest },
        selection: { hostRef: spec.target.hostRef, rootPolicyId: rootId, rootPolicyRevision: '1', locationRevision: '1' },
        binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId, rootId,
          bindingRevision: 1, locationRevision: 1, canonicalPath: spec.target.destination.canonicalProjectRoot,
          filesystem, accessMode: 'exclusive-write', snapshotId: spec.source.snapshotId,
          manifestDigest: spec.source.manifestDigest }, registration: null,
        ownerPrincipalId: principal.id, authorizedByPrincipalId: principal.id,
        attestationId: spec.target.destination.attestationId, attestationDigest: spec.target.destination.attestationHash,
        boundAt: new Date().toISOString() })
      await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
        [workspaceId, JSON.stringify({ id: workspaceId, name: 'Queued source' })])
      await db.pool.query(`insert into source_approvals
        (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
        values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`, [root.source.approvedSourceId,
      root.source.snapshotId, workspaceId, principal.id, randomUUID(), root.source.manifestDigest])
      await db.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
        values($1,$2,$3,$4,'{}')`, [root.source.snapshotId, root.source.approvedSourceId, workspaceId, root.source.manifestDigest])
      await db.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
        values($1,$2,$3,1)`, [rootId, workspaceId, randomUUID()])
      await db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
        values($1,1,$2,$3,$4::jsonb)`, [rootId, workspaceId, root.source.snapshotId, JSON.stringify(root)])
      const materialize = vi.fn(async (input: { operationId: string; attempt: { executionId: string; attemptId: string } }) =>
        SourceMaterializationRecordSchema.parse({ operationId: input.operationId, reservationId: randomUUID(),
          rootPolicyId: rootId, rootPolicyRevision: '1', state: 'prepared', finalDispatchBindingHash: null,
          sourceBindingHash: 'a'.repeat(64), receipt: { version: 1, materializationId: randomUUID(),
            binding: root.binding, placementHash: 'a'.repeat(64), ...input.attempt, keyRevision: null,
            authorizationRevision: null, verifiedManifestDigest: root.source.manifestDigest,
            verifiedEntries: 1, verifiedBytes: 1, verifiedAt: new Date().toISOString(),
            localTreeIdentity: { ...filesystem, inode: '4' } } }))
      const sources = { resolveApprovedSource: async () => ({ manifest: { git: { commit: spec.source.commit } } }),
        resolveRootBinding: async () => root, prepareExecution: materialize,
        verifyPreparation: async ({ record }: { record: ReturnType<typeof SourceMaterializationRecordSchema.parse> }) =>
          sourceWorkingTreePath(record.receipt) } as unknown as PostgresSourceService
      const inventory = new CanonicalJobPreparationSources(sources,
        { choices: async () => [], revalidate: async () => {} }, { prepare: async () => {} },
        { validateDeclaredJobInputs: async () => {} }, { resolve: async () => ({
          ...root.selection, managedRuntimeRoot: db.directory, registration: null,
        }) } as never)
      const service = new CanonicalJobPreparationService(inventory)
      expect((await service.validate(db.pool, principal, workspaceId, spec)).valid).toBe(true)
      const snapshotId = randomUUID()
      const approvedSourceId = randomUUID()
      const manifestDigest = 'c'.repeat(64)
      await db.pool.query(`insert into source_approvals
        (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
        values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
      [approvedSourceId, snapshotId, workspaceId, principal.id, randomUUID(), manifestDigest])
      await db.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
        values($1,$2,$3,$4,'{}')`, [snapshotId, approvedSourceId, workspaceId, manifestDigest])
      const advanced = { ...root, attestationId: randomUUID(), source: { approvedSourceId, snapshotId, manifestDigest },
        binding: { ...root.binding, bindingRevision: 2, snapshotId, manifestDigest }, boundAt: new Date().toISOString() }
      await db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
        values($1,2,$2,$3,$4::jsonb)`, [rootId, workspaceId, snapshotId, JSON.stringify(advanced)])
      await db.pool.query('update source_root_catalog set current_binding_revision=2 where root_id=$1', [rootId])
      expect((await service.validate(db.pool, principal, workspaceId, spec)).valid).toBe(false)
      expect((await service.validate(db.pool, principal, workspaceId, spec, { queued: true })).valid).toBe(true)
      const prepared = await service.accept(db.pool, principal, workspaceId, spec,
        { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() })
      expect(prepared.source.commit).toBe(spec.source.commit)
      expect(prepared.source.snapshotId).toBe(root.source.snapshotId)
      expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ bindingRevision: 1, source: root.source }))
    } finally { await db.close() }
  }, 60000)
})
