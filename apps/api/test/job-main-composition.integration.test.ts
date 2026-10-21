import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { createProductionJobs } from '../src/modules/jobs/production.js'
import { InstalledJobRuntimeConfigurationSchema } from '../src/modules/jobs/installedRuntimeHost.js'
import { buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

/** Exercises production composition and readiness; it does not claim physical qualification. */
describe.skipIf(!postgresEnabled)('default installed Main Job composition', () => {
  it('composes its executor without injection and preserves qualification as a separate requirement', async () => {
    const db = await currentDatabase()
    let runtime: Awaited<ReturnType<typeof createProductionJobs>> | undefined
    try {
      const mainId = (await db.pool.query('select id from application_installation')).rows[0].id
      const owner = await new PostgresAccessService(db.pool).issue({ name: 'Main settings owner', audience: 'operator',
        grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }],
        expiresAt: new Date(Date.now() + 600_000) })
      const workspaceId = randomUUID()
      const rootId = randomUUID()
      const digest = 'a'.repeat(64)
      const namespace = join(db.directory, 'source-materializations', rootId)
      await mkdir(namespace, { mode: 0o700, recursive: true })
      const root = SourceRootRecordSchema.parse({ version: 1,
        source: { approvedSourceId: rootId, snapshotId: rootId, manifestDigest: digest },
        selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: rootId,
          rootPolicyRevision: '1', locationRevision: '1' },
        binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId, rootId,
          bindingRevision: 1, locationRevision: 1, canonicalPath: namespace,
          filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write',
          snapshotId: rootId, manifestDigest: digest }, ownerPrincipalId: owner.principal.id,
        authorizedByPrincipalId: owner.principal.id, registration: null,
        attestationId: rootId, attestationDigest: digest, boundAt: new Date().toISOString() })
      const configuration = InstalledJobRuntimeConfigurationSchema.parse({ schemaVersion: 1,
        target: { hostRef: root.selection.hostRef, registration: null, mainInstallationId: mainId }, root,
        runtimeExecutable: '/usr/bin/podman', ociExecutable: '/usr/bin/crun', findmntExecutable: '/usr/bin/findmnt',
        runtimeRoot: db.directory, backingFile: join(db.directory, 'reviewed.ext4'),
        controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
        pins: { bootId: randomUUID(), runtimeBinarySha256: digest, ociBinarySha256: digest,
          findmntBinarySha256: digest, configurationDigest: digest,
          imageDigest: `sha256:${digest}`, toolchainDigest: digest, diskBytes: 2 ** 30 } })
      const configurationPath = join(db.directory, 'job-runtime.json')
      await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 })
      const commands = new PostgresCommandCoordinator(db.pool)
      runtime = await createProductionJobs({ pool: db.pool, commands,
        locations: new WorkspaceLocationService(db.pool, commands), mainId,
        runtimeRoot: db.directory, storageRoot: join(db.directory, 'files'),
        nativeRegistry: new NativeProcessRegistry(join(db.directory, 'native-processes')),
        endpoint: () => { throw new Error('Main readiness cannot contact a device.') } })
      const target = buildComputerTarget({ hostRef: root.selection.hostRef,
        registration: null, mainInstallationId: mainId })
      const result = await runtime.buildComputers.update(owner.principal, 'mcp', { target,
        commandId: randomUUID(), expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
      expect(result.state).toBe('setup-required')
      expect(result.reasons).toEqual(['Approve a writable workspace root and qualify a CI runtime.'])
      expect((await runtime.buildComputers.read(owner.principal, { target }, 'mcp')).preference)
        .toEqual(result.preference)
    } finally {
      await runtime?.close()
      await db.close()
    }
  }, 120_000)
})
