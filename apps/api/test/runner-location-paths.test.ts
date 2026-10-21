import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_HARNESS_DEFAULTS, HarnessExecutionRequestSchema } from '@foreman-code/contracts'
import { ManagedWorkspaceCommandResultSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { commandInputHash, PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { pathsOverlap, canonicalRuntimePath, withFilesystemDeadline } from '../src/modules/workspaces/filesystem.js'
import { replayWorkspaceResult } from '../src/modules/workspaces/receipts.js'

const principal: ManagementPrincipal = {
  id: 'operator', name: 'Operator', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['workspaces:create'], scope: {} }],
}
const legacy = { workspace: { id: 'workspace-a', name: 'A' }, revision: 1, archivedAt: null }
const posix = process.platform === 'win32' ? it.skip : it

function request(workingDirectory: string) {
  return HarnessExecutionRequestSchema.parse({
    executionId: 'execution', runId: 'run', workspaceId: 'workspace-a', workflowNodeId: 'node',
    workingDirectory, runtimeDirectory: `${workingDirectory}-runtime `, input: {},
    configuration: {
      id: 'configuration', workspaceId: 'workspace-a', agentId: 'agent', version: 1,
      prompt: {}, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex,
      contentHash: 'fixture', createdAt: new Date().toISOString(),
    },
  })
}

describe('PR #5 runner locations', () => {
  it('preserves both accepted launch paths byte-for-byte and rejects NUL', () => {
    const parsed = request('/projects/project ')
    expect(parsed.workingDirectory).toBe('/projects/project ')
    expect(parsed.runtimeDirectory).toBe('/projects/project -runtime ')
    expect(() => HarnessExecutionRequestSchema.parse({ ...parsed, workingDirectory: '/projects/a\0b' })).toThrow()
    expect(() => HarnessExecutionRequestSchema.parse({ ...parsed, runtimeDirectory: '' })).toThrow()
  })

  it('detects containment by path segments, not a two-dot name prefix', () => {
    const project = join(tmpdir(), 'project')
    expect(pathsOverlap(project, join(project, '..scratch'))).toBe(true)
    expect(pathsOverlap(join(project, 'child'), project)).toBe(true)
    expect(pathsOverlap(project, `${project}-sibling`)).toBe(false)
  })

  posix('canonicalizes aliases and missing descendants, but rejects dangling symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr5-canonical-'))
    try {
      const project = join(root, 'project')
      await mkdir(join(project, 'runtime'), { recursive: true })
      const alias = join(root, 'alias')
      await symlink(join(project, 'runtime'), alias, 'dir')
      for (const path of [alias, join(alias, 'not-created', 'yet')]) {
        expect(pathsOverlap(project, await withFilesystemDeadline((check) => canonicalRuntimePath(path, check)))).toBe(true)
      }
      await symlink(join(root, 'missing'), join(root, 'broken'), 'dir')
      await expect(withFilesystemDeadline((check) => canonicalRuntimePath(join(root, 'broken', 'child'), check))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('settles a stalled filesystem lookup on timeout without continuing after it resolves', async () => {
    let release!: () => void
    let continued = false
    const pending = new Promise<void>((resolve) => { release = resolve })
    await expect(withFilesystemDeadline(async (check) => {
      await check(() => pending)
      continued = true
    }, undefined, 15)).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_TIMEOUT' })
    release()
    await Promise.resolve()
    expect(continued).toBe(false)
  })

  it('settles immediately on Stop and observes a later rejected lookup', async () => {
    const controller = new AbortController()
    let rejectRead!: (error: Error) => void
    const pending = new Promise<void>((_resolve, reject) => { rejectRead = reject })
    const result = withFilesystemDeadline((check) => check(() => pending), controller.signal)
    const expected = expect(result).rejects.toThrow('Stop')
    controller.abort(new Error('Stop'))
    await expected
    rejectRead(new Error('Late filesystem rejection'))
    await Promise.resolve()
  })

  for (const source of ['http', 'mcp'] as const) {
    it(`replays a PR #4 workspace receipt for ${source} without running its mutation`, async () => {
      const payload = { commandId: 'legacy-command', name: 'A' }
      const perform = vi.fn(async () => { throw new Error('Receipt must not repeat mutation') })
      const client = {
        query: vi.fn(async (sql: string) => ({ rows: sql.includes('from management_command_receipts')
          ? [{ input_hash: commandInputHash(payload), target_key: 'workspaces:new', result: legacy }] : [] })),
        release: vi.fn(),
      }
      const coordinator = new PostgresCommandCoordinator({ connect: async () => client } as unknown as pg.Pool)
      const result = await coordinator.execute({
        principal, source, operation: 'workspace.create', commandId: payload.commandId,
        targetKey: 'workspaces:new', payload, perform, replayResult: replayWorkspaceResult,
      })
      expect(ManagedWorkspaceCommandResultSchema.parse(result)).toEqual({ value: {
        ...legacy, executionLocation: null, locationRevision: 0, locationValidation: { status: 'restricted' },
      }, replayed: true })
      expect(perform).not.toHaveBeenCalled()
      expect(client.release).toHaveBeenCalledOnce()
      expect(legacy).not.toHaveProperty('executionLocation')
    })
  }

  it('adapts only complete legacy receipts, never malformed partial new results', () => {
    expect(() => replayWorkspaceResult({ ...legacy, locationRevision: 2 })).toThrow()
    expect(() => replayWorkspaceResult({ ...legacy, unexpected: true })).toThrow()
    const modern = replayWorkspaceResult(legacy)
    expect(replayWorkspaceResult(modern)).toEqual(modern)
  })

})
