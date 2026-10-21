import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { LOCAL_RUNNER_ID, WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { createActivityReplayFileStorage, createActivityReplayWorkspace, startActivityReplayProduction } from './helpers/activityReplayLifecycle.js'

it('initializes real private fixture storage outside the temporary workspace and harness roots', async () => {
  const root = await createActivityReplayFileStorage()
  const workspace = join(tmpdir(), 'recorded-activity-workspace')
  try {
    await expect(new FileByteStorage(root, 1024, [workspace]).initialize()).resolves.toBeUndefined()
    await expect(new FileByteStorage(join(workspace, 'files'), 1024, [workspace]).initialize())
      .rejects.toThrow('File storage must be separate from temporary, workspace, and harness directories.')
    await expect(new FileByteStorage(root, 1024, [root]).initialize())
      .rejects.toThrow('File storage must be separate from temporary, workspace, and harness directories.')
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const boundary of ['register', 'initialize', 'listen'] as const) {
  it(`retains shutdown before a failed ${boundary} startup boundary`, async () => {
    const closes: Array<() => Promise<void>> = []
    const failure = new Error(`failed ${boundary}`)
    const enter = (name: typeof boundary) => {
      expect(closes).toHaveLength(1)
      if (boundary === name) throw failure
    }
    const shutdown = vi.fn(async () => undefined), drain = vi.fn(async () => undefined)
    const production = { registerFileStorage: () => { enter('register'); return undefined },
      initialize: async () => { enter('initialize') }, shutdown,
      app: { listen: vi.fn(async () => { enter('listen'); return 'http://127.0.0.1:1' }) } }
    await expect(startActivityReplayProduction(production, { drain }, closes, 1)).rejects.toBe(failure)
    await closes.pop()!()
    expect(drain).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })
}

it('shuts down the exact initial and restarted instances even if replay drain fails', async () => {
  const closes: Array<() => Promise<void>> = []
  const initial = vi.fn(async () => undefined), restarted = vi.fn(async () => undefined)
  const failure = new Error('replay drain failed')
  const replay = { drain: async () => { throw failure } }
  for (const shutdown of [initial, restarted]) {
    await startActivityReplayProduction({ registerFileStorage: () => undefined, initialize: async () => {},
      shutdown, app: { listen: async () => 'http://127.0.0.1:1' } }, replay, closes, 1)
  }
  await expect(closes.pop()!()).rejects.toBe(failure)
  expect(restarted).toHaveBeenCalledOnce()
  expect(initial).not.toHaveBeenCalled()
  await expect(closes.pop()!()).rejects.toBe(failure)
  expect(initial).toHaveBeenCalledOnce()
})

it('admits the replay project on the real local runner without overlapping harness storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'activity-replay-layout-'))
  const pool = { query: async () => ({ rows: [{ archived_at: null }] }) } as unknown as pg.Pool
  const commands = { recordAudit: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  const principal: ManagementPrincipal = { id: 'fixture-owner', name: 'Fixture owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['workspace_locations:validate'], scope: { workspaceIds: ['workspace'] } }] }
  try {
    const layout = await createActivityReplayWorkspace(directory)
    const locations = new WorkspaceLocationService(pool, commands, layout.harnessWorkspaceRoot, LOCAL_RUNNER_ID)
    const request = { workspaceId: 'workspace', runnerId: LOCAL_RUNNER_ID, rootPath: layout.workingDirectory, accessMode: 'read-only' as const }
    expect(await locations.validate(principal, 'http', request)).toMatchObject({ location: { runnerId: 'runner-local', rootPath: layout.workingDirectory } })
    await expect(locations.validate(principal, 'http', { ...request, runnerId: 'local' })).rejects.toMatchObject({ code: 'RUNNER_UNSUPPORTED' })
    const overlap = new WorkspaceLocationService(pool, commands, layout.harnessWorkspaceRoot)
    await expect(overlap.validate(principal, 'http', { ...request, rootPath: layout.harnessWorkspaceRoot }))
      .rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_RUNTIME_OVERLAP' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
