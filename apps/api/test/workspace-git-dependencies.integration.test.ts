import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagementActionSchema, ManagedWorkspaceCommandResultSchema, WorkspaceStorageFoldersPageSchema }
  from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

const execute = promisify(execFile)
async function git(path: string, ...args: string[]) {
  const result = await execute('git', ['-C', path, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  return result.stdout.trim()
}

async function fixture(options: { repository?: 'unregistered' } = {}) {
  const db = await currentDatabase()
  const clients: Client[] = []
  const parent = join(db.directory, 'workspaces')
  const runtime = join(db.directory, 'runtime')
  await mkdir(parent)
  await mkdir(runtime)
  const commands = new PostgresCommandCoordinator(db.pool)
  const access = new PostgresAccessService(db.pool)
  const locations = new WorkspaceLocationService(db.pool, commands, runtime, 'runner-local')
  const defaults = new PostgresFoundationSettingsRepository(db.pool, parent)
  const workspaces = new WorkspaceManagementService(db.pool, commands, locations, defaults, parent)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, locations, workspaces } as unknown as OperatorServices },
  })
  const owner = await access.issue({ name: 'Folder owner', audience: 'operator',
    grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const reader = await access.issue({ name: 'Folder reader', audience: 'operator',
    grants: [{ actions: ['workspaces:read', 'workspace_locations:read'], scope: {} }] })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async (token: string) => {
    const client = new Client({ name: 'Git dependency regression', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  const client = await connect(owner.token)
  const denied = await connect(reader.token)
  const create = async (name: string) => {
    const created = await client.callTool({ name: 'workspace_create', arguments: { name, parentPath: parent } })
    expect(created.isError, JSON.stringify(created)).not.toBe(true)
    return ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(created)).value
  }
  const workspace = options.repository === 'unregistered' ? undefined : await create('Repository')
  const repository = workspace?.executionLocation!.rootPath ?? join(parent, 'Repository')
  if (!workspace) await mkdir(repository)
  await git(repository, 'init', '--template=')
  await writeFile(join(repository, 'retained.txt'), 'Retained Git objects')
  await git(repository, 'add', 'retained.txt')
  await git(repository, '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Initial content')
  const linked = join(db.directory, 'linked')
  await git(repository, 'worktree', 'add', '--detach', linked, 'HEAD')
  return { db, client, denied, create, parent, repository, workspace, linked, async close() {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await db.close()
  } }
}

it.each([
  { archive: 'workspace_archive', state: 'queued' },
  { archive: 'workspace_batch_archive', state: 'active' },
])('$archive protects a Git common directory used only by a $state chat', async ({ archive, state }) => {
  const f = await fixture()
  try {
    const registered = join(f.db.directory, 'registered')
    await mkdir(registered)
    const seed = await seedAgent3(f.db.pool, registered, makeCurrentWorkflowFixture(randomUUID(), 'single'), { run: false })
    const node = agentWorkflowNode(seed.version.definition.nodes[0])
    const context = { workspaceId: seed.run.workspaceId, workflowId: seed.run.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const chats = new PostgresAgentChatRepository(f.db.pool)
    const requestId = randomUUID()
    const admitted = await chats.admit({ key: agentChatKey(context), context, delivery: 'queued',
      request: { requestId, content: 'Continue', intent: 'next_turn', expectedConversationId: null,
        context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId } },
      create: { context, harness: 'codex', agentConfigurationVersionId: seed.configurations[0]!.id,
        origin: { kind: 'fresh' }, workingDirectory: f.linked, runtimeDirectory: join(f.db.directory, 'runtime') } })
    if (state === 'active') expect(await chats.claim(admitted.conversationId, requestId)).toBe(true)
    const workspace = (await f.db.pool.query<{ id: string; revision: string }>(
      "select id,revision from workspaces where execution_location->>'rootPath'=$1", [f.repository])).rows[0]!
    const item = { workspaceId: workspace.id, expectedRevision: Number(workspace.revision) }
    const input = { commandId: randomUUID(), ...(archive === 'workspace_archive' ? item : { workspaces: [item] }) }
    await expectMcpAccessDenied(f.denied.callTool({ name: archive, arguments: input }))
    const archived = await f.client.callTool({ name: archive, arguments: input })
    expect(archived.isError).toBe(true)
    expect(archived.content).toEqual([{ type: 'text', text: expect.stringContaining('WORKSPACE_FOLDER_CLEANUP_FAILED') }])
    expect(await git(f.linked, 'show', 'HEAD:retained.txt')).toBe('Retained Git objects')
    const readback = await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: workspace.id } })
    expect(decodeMcpToolResult(readback)).toMatchObject({ archivedAt: expect.any(String) })
    const listing = await f.client.callTool({ name: 'workspace_storage_folders_list', arguments: {} })
    expect(listing.isError).not.toBe(true)
    const folder = WorkspaceStorageFoldersPageSchema.parse(decodeMcpToolResult(listing)).items
      .find(item => item.path === f.repository)!
    const deletion = { path: folder.path, expectedIdentity: folder.identity }
    expect((await f.client.callTool({ name: 'workspace_storage_folder_delete', arguments: deletion })).isError).toBe(true)
    if (state === 'active') {
      expect(await chats.finish(admitted.conversationId, requestId, { outcome: 'canceled' })).toBe(true)
    } else {
      expect(await chats.cancelQueued(admitted.conversationId, requestId)).toBe(1)
    }
    expect((await f.client.callTool({ name: archive, arguments: input })).isError).not.toBe(true)
    await expect(lstat(f.repository)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
}, 120_000)

it.each(['missing worktree metadata', 'missing object store'])(
  'keeps unrelated archive and storage operations available with %s', async damage => {
    const f = await fixture()
    try {
      await seedAgent3(f.db.pool, f.linked, makeCurrentWorkflowFixture(randomUUID(), 'single'))
      if (damage === 'missing worktree metadata') {
        await rm(join(f.repository, '.git', 'worktrees', 'linked'), { recursive: true })
        await writeFile(join(f.linked, '.git'),
          `gitdir: ${relative(f.linked, join(f.repository, '.git', 'worktrees', 'linked'))}\n`)
      } else {
        await rm(join(f.repository, '.git', 'objects'), { recursive: true })
      }
      await expect(git(f.linked, 'rev-parse', '--git-common-dir')).rejects.toThrow()
      const unrelated = await f.create('Unrelated')
      const input = { workspaceId: unrelated.workspace.id, expectedRevision: unrelated.revision, commandId: randomUUID() }
      await expectMcpAccessDenied(f.denied.callTool({ name: 'workspace_archive', arguments: input }))
      const archived = await f.client.callTool({ name: 'workspace_archive', arguments: input })
      expect(archived.isError, JSON.stringify(archived)).not.toBe(true)
      await expect(lstat(unrelated.executionLocation!.rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const readback = await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: unrelated.workspace.id } })
      expect(decodeMcpToolResult(readback)).toMatchObject({ archivedAt: expect.any(String) })
      const unused = join(f.parent, 'Unused')
      await mkdir(unused)
      const listed = await f.client.callTool({ name: 'workspace_storage_folders_list', arguments: {} })
      expect(listed.isError, JSON.stringify(listed)).not.toBe(true)
      const page = WorkspaceStorageFoldersPageSchema.parse(decodeMcpToolResult(listed))
      const folder = page.items.find(item => item.path === unused)!
      expect(folder.deletion).toEqual({ status: 'available' })
      const deletion = { path: unused, expectedIdentity: folder.identity }
      await expectMcpAccessDenied(f.denied.callTool({ name: 'workspace_storage_folder_delete', arguments: deletion }))
      expect((await f.client.callTool({ name: 'workspace_storage_folder_delete', arguments: deletion })).isError).not.toBe(true)
      await expect(lstat(unused)).rejects.toMatchObject({ code: 'ENOENT' })
      const retained = await f.client.callTool({ name: 'workspace_archive', arguments: {
        workspaceId: f.workspace!.workspace.id, expectedRevision: f.workspace!.revision,
      } })
      expect(retained.isError).toBe(true)
      expect(retained.content).toEqual([{ type: 'text', text: expect.stringContaining('WORKSPACE_FOLDER_CLEANUP_FAILED') }])
      expect(await readFile(join(f.repository, 'retained.txt'), 'utf8')).toBe('Retained Git objects')
    } finally { await f.close() }
  }, 120_000)

it('protects unregistered Git storage required by an idle workspace', async () => {
  const f = await fixture({ repository: 'unregistered' })
  try {
    await seedAgent3(f.db.pool, f.linked, makeCurrentWorkflowFixture(randomUUID(), 'single'), { run: false })
    const listed = await f.client.callTool({ name: 'workspace_storage_folders_list', arguments: {} })
    expect(listed.isError).not.toBe(true)
    const folder = WorkspaceStorageFoldersPageSchema.parse(decodeMcpToolResult(listed)).items
      .find(item => item.path === f.repository)!
    expect(folder.deletion).toMatchObject({ status: 'protected', reason: 'workspace' })
    const input = { path: folder.path, expectedIdentity: folder.identity }
    await expectMcpAccessDenied(f.denied.callTool({ name: 'workspace_storage_folder_delete', arguments: input }))
    const deleted = await f.client.callTool({ name: 'workspace_storage_folder_delete', arguments: input })
    expect(deleted.isError).toBe(true)
    expect(deleted.content).toEqual([{ type: 'text', text: expect.stringContaining('DIRECTORY_IN_USE') }])
    expect(await git(f.linked, 'show', 'HEAD:retained.txt')).toBe('Retained Git objects')
  } finally { await f.close() }
}, 120_000)

it.each(['malformed gitdir', 'empty commondir', 'unreadable commondir'])(
  'isolates an idle workspace with %s while retaining known Git dependencies', async damage => {
    const f = await fixture({ repository: 'unregistered' })
    try {
      await seedAgent3(f.db.pool, f.linked, makeCurrentWorkflowFixture(randomUUID(), 'single'), { run: false })
      const commonFile = join(f.repository, '.git', 'worktrees', 'linked', 'commondir')
      if (damage === 'malformed gitdir') {
        const healthy = join(f.db.directory, 'healthy-linked')
        await git(f.repository, 'worktree', 'add', '--detach', healthy, 'HEAD')
        await seedAgent3(f.db.pool, healthy, makeCurrentWorkflowFixture(randomUUID(), 'single'), { run: false })
        await writeFile(join(f.linked, '.git'), 'gitdir:')
      } else if (damage === 'empty commondir') {
        await writeFile(commonFile, '\n')
      } else {
        await rm(commonFile)
        await mkdir(commonFile)
      }
      const listed = await f.client.callTool({ name: 'workspace_storage_folders_list', arguments: {} })
      expect(listed.isError, JSON.stringify(listed)).not.toBe(true)
      const page = WorkspaceStorageFoldersPageSchema.parse(decodeMcpToolResult(listed))
      const repository = page.items.find(item => item.path === f.repository)!
      expect(repository.deletion).toMatchObject({ status: 'protected', reason: 'workspace' })
      const deletion = { path: repository.path, expectedIdentity: repository.identity }
      await expectMcpAccessDenied(f.denied.callTool({ name: 'workspace_storage_folder_delete', arguments: deletion }))
      const removed = await f.client.callTool({ name: 'workspace_storage_folder_delete', arguments: deletion })
      expect(removed.isError).toBe(true)
      expect(removed.content).toEqual([{ type: 'text', text: expect.stringContaining('DIRECTORY_IN_USE') }])
      const unrelated = await f.create('Unrelated')
      const input = { workspaceId: unrelated.workspace.id, expectedRevision: unrelated.revision, commandId: randomUUID() }
      await expectMcpAccessDenied(f.denied.callTool({ name: 'workspace_archive', arguments: input }))
      const archived = await f.client.callTool({ name: 'workspace_archive', arguments: input })
      expect(archived.isError, JSON.stringify(archived)).not.toBe(true)
      await expect(lstat(unrelated.executionLocation!.rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const readback = await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: unrelated.workspace.id } })
      expect(decodeMcpToolResult(readback)).toMatchObject({ archivedAt: expect.any(String) })
      expect(await readFile(join(f.repository, 'retained.txt'), 'utf8')).toBe('Retained Git objects')
    } finally { await f.close() }
  }, 120_000)
