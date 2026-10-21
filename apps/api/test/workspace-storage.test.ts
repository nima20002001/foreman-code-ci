import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

it('allows selected folders and symlinked projects outside storage while protecting runtime', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const fixture = await mkdtemp(join(cache, 'workspace-storage-'))
  try {
    const projects = join(fixture, 'workspaces')
    const runtime = join(fixture, 'runtime')
    const outside = join(fixture, 'outside')
    await Promise.all([mkdir(projects), mkdir(runtime), mkdir(outside)])
    await symlink(outside, join(projects, 'escape'))
    const pool = { query: vi.fn(async () => ({ rows: [{ archived_at: null }] })) } as unknown as pg.Pool
    const commands = { recordAudit: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
    const locations = new WorkspaceLocationService(pool, commands, runtime, 'runner-local')
    const principal: ManagementPrincipal = {
      id: 'storage-owner', name: 'Storage owner', audience: 'operator', revokedAt: null,
      expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ actions: ['workspace_locations:validate', 'workspace_locations:read', 'workspace_locations:update', 'workspace_locations:provision'], scope: {} }],
    }
    const input = { workspaceId: 'workspace-1', runnerId: 'runner-local', accessMode: 'read-only' as const }
    const allowed = await locations.validate(principal, 'mcp', { ...input, rootPath: projects })
    expect(allowed.location.rootPath).toBe(await realpath(projects))
    for (const rootPath of [outside, join(projects, 'escape')]) {
      expect((await locations.validate(principal, 'mcp', { ...input, rootPath })).location.rootPath)
        .toBe(await realpath(outside))
    }
    const external = await locations.createProjectFolder(principal, 'workspace-1', outside, 'Selected')
    expect(external.validation.location.rootPath).toBe(join(outside, 'Selected'))
    await expect(locations.validate(principal, 'mcp', { ...input, rootPath: runtime }))
      .rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_RUNTIME_OVERLAP' })
    await expect(locations.createProjectFolder(principal, 'workspace-1', runtime, 'Forbidden'))
      .rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_RUNTIME_OVERLAP' })
    expect(await readdir(outside)).toEqual(['Selected'])
    expect(await readdir(runtime)).toEqual([])
    const created = await locations.createProjectFolder(principal, 'workspace-1', projects, 'Allowed')
    expect(created.validation.location.rootPath).toBe(join(projects, 'Allowed'))
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
