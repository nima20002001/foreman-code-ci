import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { fixtureGit, fixtureRepository } from './helpers/workspaceRepository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'

function gate() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

it.each(['inventory', 'capture'] as const)(
  'serves authenticated reads while source %s waits with a saturated application pool', async stage => {
    let pool!: pg.Pool
    let sources!: PostgresSourceService
    let origin!: string
    let commit!: string
    let store!: PrivateSourceSnapshotStore
    const entered = gate()
    const blocked = gate()
    const f = await workspaceMcpFixture({ configureServices: async fixture => {
      pool = new pg.Pool({ ...fixture.pool.options, max: 2, connectionTimeoutMillis: 1000 })
      const mainId = (await pool.query('select id from application_installation where singleton=true')).rows[0].id
      origin = join(fixture.parentPath, 'origin')
      const storage = join(fixture.parentPath, 'source-store')
      await mkdir(origin, { mode: 0o700 })
      await mkdir(storage, { mode: 0o700 })
      fixtureGit(origin, 'init', '--template=', '-q')
      await writeFile(join(origin, 'source.txt'), 'committed source bytes\n')
      fixtureGit(origin, 'add', '.')
      fixtureGit(origin, 'commit', '-qm', 'source')
      commit = fixtureGit(origin, 'rev-parse', 'HEAD')
      store = new PrivateSourceSnapshotStore(storage)
      type Dependencies = ConstructorParameters<typeof PostgresSourceService>
      sources = new PostgresSourceService(pool, new PostgresCommandCoordinator(pool), fixture.services.locations,
        store, mainId, {} as Dependencies[5], {} as Dependencies[6], {} as Dependencies[7])
      fixture.services.sources = sources
    } })
    let held: pg.PoolClient | undefined
    let approval: ReturnType<typeof sources.approve> | undefined
    const workspaceId = randomUUID()
    try {
      await pool.query(`insert into workspaces(id,record,location_revision) values($1,$2::jsonb,1)`,
        [workspaceId, JSON.stringify({ id: workspaceId, name: 'Source fixture', repository: fixtureRepository })])
      const waitForRelease = async () => { entered.release(); await blocked.pending }
      if (stage === 'inventory') {
        const readCapacity = store.storageCapacity.bind(store)
        vi.spyOn(store, 'storageCapacity').mockImplementation(async () => {
          await waitForRelease()
          return readCapacity()
        })
      } else {
        const write = store.write.bind(store)
        vi.spyOn(store, 'write').mockImplementation(async (...args) => {
          await waitForRelease()
          return write(...args)
        })
      }
      approval = sources.approve(f.owner.principal, 'http', { workspaceId, commandId: randomUUID(),
        expectedLocationRevision: 1, commit, executablePolicy: 'strip' },
      { repository: `${fixtureRepository.owner}/${fixtureRepository.name}`, clone: origin })
      await entered.pending
      held = await pool.connect()
      const url = new URL(`/api/management/workspaces/${workspaceId}/sources`, f.address)
      const response = await fetch(url, { headers: { authorization: `Bearer ${f.owner.token}` },
        signal: AbortSignal.timeout(5000) })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ items: [] })
      const denied = await f.issue([{ actions: ['sources:read'], scope: { workspaceIds: ['another-workspace'] } }])
      expect((await fetch(url, { headers: { authorization: `Bearer ${denied.token}` } })).status).toBe(403)
      held.release()
      held = undefined
      blocked.release()
      const result = await approval
      const readback = await fetch(url, { headers: { authorization: `Bearer ${f.owner.token}` } })
      expect(readback.status).toBe(200)
      expect(await readback.json()).toMatchObject({ items: [{ manifest: result.value.manifest }] })
      expect((await pool.query('select record from source_snapshots where workspace_id=$1', [workspaceId])).rows)
        .toEqual([{ record: result.value }])
    } finally {
      held?.release()
      blocked.release()
      try { await approval } finally {
        vi.restoreAllMocks()
        await pool.end()
        await f.close()
      }
    }
  },
)
