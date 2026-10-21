import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { sourceWorktreeMcpFixture } from './helpers/sourceWorktreeMcpFixture.js'
import { deferred } from './helpers/deferred.js'
import { fixtureGit } from './helpers/workspaceRepository.js'
import { RegisteredWorkspaceSourceRoots } from '../src/modules/sources/registeredSourceRoots.js'

afterEach(() => vi.restoreAllMocks())

it.each(['attestation', 'admission'] as const)(
  'retains the captured Start source during %s under pressure', async phase => {
    const f = await sourceWorktreeMcpFixture({ approvalNodeIds: [] })
    const entered = deferred()
    const resume = deferred()
    let attested = false
    const attest = RegisteredWorkspaceSourceRoots.prototype.attest
    const location = f.base.locations.snapshotAssigned.bind(f.base.locations)
    vi.spyOn(RegisteredWorkspaceSourceRoots.prototype, 'attest').mockImplementation(async function (this: RegisteredWorkspaceSourceRoots, root) {
      const result = await attest.call(this, root)
      attested = true
      if (phase === 'attestation') {
        entered.resolve()
        await resume.promise
      }
      return result
    })
    vi.spyOn(f.base.locations, 'snapshotAssigned').mockImplementation(async (...args) => {
      if (phase === 'admission' && attested) {
        entered.resolve()
        await resume.promise
      }
      return location(...args)
    })
    let start: ReturnType<typeof f.client.callTool> | undefined
    try {
      const reader = await f.base.access.issue({ name: 'Source observer', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: [f.input.workspaceId] } }] })
      const denied = await (await f.connect(reader.token)).callTool({ name: 'run_start', arguments: {
        ...f.input, commandId: randomUUID(),
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const project = join(f.base.db.directory, 'project')
      const unused = (await f.production.sources.approve(f.base.writer.principal, 'mcp', {
        workspaceId: f.input.workspaceId, commandId: randomUUID(),
        expectedLocationRevision: f.input.expectedLocationRevision, executablePolicy: 'strip',
        commit: fixtureGit(project, 'rev-parse', 'HEAD'),
      })).value
      await writeFile(join(project, 'app.txt'), 'source captured by Start\n')
      fixtureGit(project, 'add', '.')
      fixtureGit(project, 'commit', '-qm', 'Start source')
      const commit = fixtureGit(project, 'rev-parse', 'HEAD')
      start = f.client.callTool({ name: 'run_start', arguments: { ...f.input, commandId: randomUUID() } })
      await Promise.race([entered.promise, start.then(reply => {
        throw new Error(`Start returned before the ${phase} barrier: ${JSON.stringify(reply)}`)
      })])
      const captured = (await f.base.db.pool.query<{ snapshot_id: string }>(
        "select snapshot_id from source_snapshots where workspace_id=$1 and record#>>'{manifest,git,commit}'=$2",
        [f.input.workspaceId, commit])).rows
      expect(captured).toHaveLength(1)
      const snapshotId = captured[0]!.snapshot_id
      if (phase === 'admission') {
        // Another binding replaces the temporary catalog reference before the Run commits.
        const current = (await f.production.sources.rootList(f.base.writer.principal, 'mcp', {
          workspaceId: f.input.workspaceId,
        })).items[0]!
        await f.production.sources.bindRoot(f.base.writer.principal, 'mcp', {
          workspaceId: f.input.workspaceId, commandId: randomUUID(), source: f.source,
          selection: f.root.selection, accessMode: f.root.binding.accessMode,
          expectedBindingRevision: current.binding.bindingRevision,
        })
      }
      await f.production.sources.releaseUnusedSnapshots(undefined, true)
      expect((await f.base.db.pool.query('select availability from source_snapshots where snapshot_id=$1',
        [snapshotId])).rows).toEqual([{ availability: 'retained' }])
      expect(await f.production.snapshots.retainedCaptureBytes(snapshotId)).toBeGreaterThan(0)
      expect((await f.base.db.pool.query('select availability from source_snapshots where snapshot_id=$1',
        [unused.manifest.snapshotId])).rows).toEqual([{ availability: 'unavailable' }])
      expect(await f.production.snapshots.retainedCaptureBytes(unused.manifest.snapshotId)).toBe(0)
      resume.resolve()
      const reply = await start
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
      const run = RunStartV3ResultSchema.parse(decodeMcpToolResult(reply)).run
      const placements = await f.base.db.pool.query<{ snapshot_id: string }>(
        "select record#>>'{source,snapshotId}' as snapshot_id from run_node_placements where run_id=$1", [run.id])
      expect(placements.rows).toHaveLength(2)
      expect(placements.rows.every(row => row.snapshot_id === snapshotId)).toBe(true)
    } finally {
      resume.resolve()
      await start
      await f.close()
    }
  },
)
