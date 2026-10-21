import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { WorkspaceStorageFolders } from './storageFolders.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workspaces:read', 'workspaces:archive', 'workspace_locations:read', 'workspace_locations:provision'], scope: {} }] }

it.each(['continuing run', 'active chat'])('protects a storage folder used by %s during discovery and deletion', async source => {
    const parent = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'storage-protection-'))
    roots.push(root)
    const path = join(root, 'project')
    await mkdir(path)
    await writeFile(join(path, 'work.txt'), 'active work')
    let active = false
    // Query dependencies return the directory rows owned by each subsystem; no service is mocked.
    const query = async (text: string) => {
      if (text.includes('with continuing_runs')) {
        return { rows: active && source !== 'active chat' ? [{ path: join(path, 'child') }] : [] }
      }
      if (text.includes('from operator_conversations')) {
        return { rows: active && source === 'active chat' ? [{ path: join(path, 'child') }] : [] }
      }
      return { rows: [] }
    }
    const sql = { query }
    const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) =>
      ({ value: await input.perform(sql as unknown as pg.PoolClient), replayed: false }) } as PostgresCommandCoordinator
    const folders = new WorkspaceStorageFolders(sql as unknown as pg.Pool, commands, root)
    const discovered = (await folders.list(principal, {})).items[0]!
    expect(discovered.deletion.status).toBe('available')
    active = true
    const protectedFolder = (await folders.list(principal, {})).items[0]!
    expect(protectedFolder.deletion).toMatchObject({ status: 'protected', reason: 'active_run' })
    await expect(folders.delete(principal, 'mcp', { commandId: randomUUID(), path, expectedIdentity: discovered.identity }))
      .rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
    expect(await readFile(join(path, 'work.txt'), 'utf8')).toBe('active work')
  })
