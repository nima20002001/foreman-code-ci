import { randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { executionRegressionDatabase } from './helpers/executionRegressions.js'

let database: Awaited<ReturnType<typeof executionRegressionDatabase>>

describe.skipIf(!postgresEnabled)('current execution snapshots regressions', () => {
  beforeEach(async () => { database = await executionRegressionDatabase() }, 60_000)
  afterEach(async () => { await database?.close() }, 60_000)

  it('keeps its accepted project directory when workspace settings later point elsewhere', async () => {
    const db = database
    try {
      const f = await currentRepositoryFixture(db)
      const accepted = f.f.run.executionLocation!
      const replacement = join(db.directory, 'replacement'); await mkdir(replacement)
      await f.locations.set(f.issued.principal, 'http', { workspaceId: f.f.scope.workspaceId,
        commandId: randomUUID(), expectedLocationRevision: accepted.locationRevision, runnerId: 'runner-local', rootPath: replacement })
      const saved = await f.repository.get(f.f.run.id)
      expect(saved?.executionLocation).toEqual(accepted)
      await f.locations.revalidateSnapshot(f.f.scope.workspaceId, accepted, 'read-only')
    } finally { await db.close() }
  })

  it('rejects a replaced accepted inode before allowing any native work', async () => {
    const db = database
    const original = `${db.directory}-original`
    try {
      const f = await currentRepositoryFixture(db)
      await rename(db.directory, original); await mkdir(db.directory)
      await expect(f.locations.revalidateSnapshot(f.f.scope.workspaceId, f.f.run.executionLocation!, 'read-only'))
        .rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_CHANGED' })
      expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toEqual([])
    } finally {
      await removeFixtureDirectory(db.directory); await rename(original, db.directory)
      await db.close()
    }
  })

  it('rechecks the accepting Operator authority before any queued native launch', async () => {
    const db = database
    try {
      const f = await currentRepositoryFixture(db)
      await new PostgresAccessService(db.pool).revoke(f.issued.principal.id)
      await expect(f.locations.revalidateRunAuthorization(f.f.run.authorizationPrincipalId!, f.f.scope.workspaceId, f.f.scope.workflowId))
        .rejects.toMatchObject({ code: 'RUN_AUTHORIZATION_REVOKED' })
      expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toEqual([])
    } finally { await db.close() }
  })

  it('does not steal live ownership and preserves the authorized Stop fence for the replacement owner', async () => {
    const db = database
    try {
      const f = await currentRepositoryFixture(db)
      const owner = await f.repository.acquireOwnership(f.f.run.id, () => undefined)
      expect(owner).toBeTruthy()
      try {
        expect(await f.repository.acquireOwnership(f.f.run.id, () => undefined)).toBeUndefined()
        await f.stop()
        expect((await f.repository.getRepeatSnapshot(f.f.run.id, owner!)).stopRequested).toBe(true)
      } finally { await owner!.release() }
      const replacement = await f.repository.acquireOwnership(f.f.run.id, () => undefined)
      expect(replacement).toBeTruthy()
      try { expect((await f.repository.getRepeatSnapshot(f.f.run.id, replacement!)).stopRequested).toBe(true) }
      finally { await replacement!.release() }
      expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toEqual([])
    } finally { await db.close() }
  })

})
