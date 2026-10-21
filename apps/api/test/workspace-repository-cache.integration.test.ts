import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { workspaceRepositoryFixture } from './helpers/workspaceRepository.js'
import { workspace, add, get, httpAdd } from './helpers/workspaceRepositoryOnboarding.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const disk = vi.hoisted(() => ({ full: false }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, statfs: async (...args: Parameters<typeof actual.statfs>) => {
    const value = await actual.statfs(...args)
    return disk.full ? { ...value, bavail: typeof value.bavail === 'bigint' ? 0n : 0 } : value
  } }
})

it('reports cache admission through authenticated MCP and HTTP and persists retry readback', async () => {
  const f = await workspaceRepositoryFixture()
  try {
    const input = await workspace(f)
    const system = systemGitWorktreePorts({ ...gitFixtureEnvironment(), HOME: f.parentPath })
    f.sources.git = { cloneDirectory: () => join(f.parentPath, 'unused-cache'),
      git: (args, options) => system.git(['-c', `url.${f.origin}.insteadOf=https://github.com/octo/site.git`,
        ...args], options) }
    const reader = await f.issue([{ actions: ['workspaces:read'], scope: { workspaceIds: [input.workspaceId] } }])
    await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_repository_add', arguments: input }))
    disk.full = true
    const failed = await f.owner.client.callTool({ name: 'workspace_repository_add', arguments: input })
    expect(failed.isError).toBe(true)
    expect(decodeMcpToolResult(failed)).toMatchObject({ error: { code: 'SOURCE_GIT_CACHE_CAPACITY' } })
    expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId }))
      .toMatchObject({ state: 'failed', operation: { failure: { code: 'SOURCE_GIT_CACHE_CAPACITY' } } })
    const http = await httpAdd(f, input)
    expect(http.status).toBe(409)
    expect(await http.json()).toMatchObject({ error: { code: 'SOURCE_GIT_CACHE_CAPACITY' } })
    disk.full = false
    const prepared = await add(f, input)
    expect(prepared.value.state).toBe('ready')
    expect(await get(f, { workspaceId: input.workspaceId })).toEqual(prepared.value)
    expect(prepared.value.approvedSource!.manifest.git!.commit).toBe(f.commit)
  } finally {
    disk.full = false
    await f.close()
  }
}, 30_000)
