import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls, type SessionControlState } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { agentChatKey, PostgresAgentChatRepository, type AgentConversationRow } from '../conversations/agentChatRepository.js'
import { HarnessDirectoryBrowser } from '../harnesses/directoryBrowser.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { WorkspaceStorageFolders } from './storageFolders.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const principal: ManagementPrincipal = {
  id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workspaces:read', 'workspaces:archive', 'workspace_locations:read', 'workspace_locations:provision'], scope: {} }],
}

/** In-memory SQL dependency with transaction-scoped locks; the services and filesystem are real. */
function database(path: string) {
  const context = { workspaceId: randomUUID(), workflowId: randomUUID(), workflowNodeId: randomUUID(), agentId: randomUUID() }
  const now = new Date()
  const conversation: AgentConversationRow = {
    id: randomUUID(), agent_key: agentChatKey(context), workspace_id: context.workspaceId,
    workflow_id: context.workflowId, workflow_node_id: context.workflowNodeId, agent_id: context.agentId,
    agent_configuration_version_id: randomUUID(), origin_run_id: null, origin_execution_id: null,
    harness: 'codex', provider_version: 'fixture', native_session_id: 'session', active_request_id: null,
    active_native_turn_id: null, cancel_requested: false, turn_state: 'idle', last_error: null,
    revision: 1, pending_interaction: null, last_result: null,
    record: { origin: { kind: 'fresh' }, workingDirectory: path, runtimeDirectory: '' },
    created_at: now, updated_at: now,
  }
  const state = {
    conversation, context, hostKind: 'main', imports: [] as Array<{ path: string }>,
    messages: [] as unknown[][], turns: [] as Record<string, unknown>[],
    receipts: [] as Array<{ operation: string; commandId: string; result: unknown }>,
    sessionControls: undefined as SessionControlState | undefined,
    runDirectories: [] as Array<{ path: string }>,
    readChatReferences: async () => {},
    beforeMessage: async () => {},
  }
  const locks = new Map<string, Map<object, { shared: boolean; done: ReturnType<typeof deferred> }>>()
  const blocked = deferred()
  function connect() {
    const owner = {}
    const held = new Set<string>()
    const releaseLocks = () => {
      for (const key of held) {
        const owners = locks.get(key)!
        owners.get(owner)!.done.resolve(undefined)
        owners.delete(owner)
        if (!owners.size) locks.delete(key)
      }
      held.clear()
    }
    const query = async (text: string, values: unknown[] = []) => {
      if (text.includes('pg_advisory_xact_lock')) {
        const key = String(values[0])
        const shared = text.includes('pg_advisory_xact_lock_shared')
        let conflict
        while ((conflict = [...(locks.get(key) ?? [])].find(([other, lock]) =>
          other !== owner && (!shared || !lock.shared)))) {
          blocked.resolve()
          await conflict[1].done.promise
        }
        const owners = locks.get(key) ?? new Map()
        owners.set(owner, owners.get(owner) ?? { shared, done: deferred() })
        locks.set(key, owners)
        held.add(key)
        return result([])
      }
      if (text === 'commit' || text === 'rollback') {
        releaseLocks()
        return result([])
      }
      return execute(text, values)
    }
    return { query, release: releaseLocks }
  }
  async function execute(text: string, values: unknown[]) {
    if (text.includes('with continuing_runs')) return result(state.runDirectories)
    if (text.includes('select execution_location')) return result([])
    if (text.includes('from workspace_repository_imports')) return result(state.imports)
    if (text.includes("c.record->>'workingDirectory'")) {
      if (text.includes('active_request_id is not null')) {
        const rows = state.turns.length && state.hostKind === 'main'
          ? [{ path: conversation.record.workingDirectory }] : []
        await state.readChatReferences()
        return result(rows)
      }
      return result([{ path: conversation.record.workingDirectory, host_kind: state.hostKind }])
    }
    if (text.includes('select * from operator_conversations')) return result([conversation])
    if (text.includes('select archived_at from workspaces')) return result([{ archived_at: null }])
    if (text.includes('select count(*)::text as count')) return result([{ count: String(state.turns.length) }])
    if (text.includes('select record from conversation_session_controls')) {
      return result(state.sessionControls ? [{ record: state.sessionControls }] : [])
    }
    if (text.includes('insert into operator_conversation_messages')) {
      await state.beforeMessage()
      state.messages.push(values)
      return result([])
    }
    if (text.includes('insert into operator_conversation_turns')) {
      const row = {
        request_id: values[1], turn_sequence: String(state.turns.length + 1), payload: JSON.parse(String(values[2])),
        input_hash: values[3], intent: values[4], delivery: values[5], message_id: values[6],
        target_native_turn_id: values[7], native_turn_id: null, delivery_error: null,
        created_at: now, updated_at: now, started_at: null,
      }
      state.turns.push(row)
      return result([row])
    }
    if (text.includes('from operator_conversation_turns')) {
      return result(state.turns.filter(turn => turn.request_id === values[1]))
    }
    if (text.includes('insert into management_command_receipts')) {
      state.receipts.push({ operation: String(values[1]), commandId: String(values[2]), result: JSON.parse(String(values[5])) })
      return result([])
    }
    if (text.includes('from management_command_receipts') && text.includes("operation='workspace.folder.create'")) {
      return result(state.receipts.filter(receipt => receipt.operation === 'workspace.folder.create' && receipt.commandId === values[1]))
    }
    return result([])
  }
  const pool = { connect, query: (text: string, values: unknown[] = []) => execute(text, values) } as unknown as pg.Pool
  return { ...state, state, pool, blocked }
}

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length }
}

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'folder-mutation-'))
  roots.push(root)
  const path = join(root, 'retained')
  await mkdir(path)
  const db = database(path)
  const folders = new WorkspaceStorageFolders(db.pool, new PostgresCommandCoordinator(db.pool), root)
  const browser = new HarnessDirectoryBrowser([root], db.pool)
  const repository = new PostgresAgentChatRepository(db.pool)
  const send = (requestId = randomUUID(), assertCurrent?: (client: pg.PoolClient) => Promise<void>) => repository.admit({
    key: db.conversation.agent_key, context: db.context, delivery: 'queued',
    ...(assertCurrent ? { assertCurrent } : {}),
    request: { requestId, content: 'Continue working', intent: 'next_turn', expectedConversationId: db.conversation.id,
      context: { workflowId: db.context.workflowId, workflowNodeId: db.context.workflowNodeId, agentId: db.context.agentId } },
  })
  const remove = async () => {
    const folder = (await folders.list(principal, {})).items[0]!
    return folders.delete(principal, 'http', { path, expectedIdentity: folder.identity, commandId: randomUUID() })
  }
  return { ...db, root, path, folders, browser, repository, send, remove }
}

it.each(['accepted', 'running', 'uncertain'] as const)(
  'returns the %s compaction rejection before checking a missing chat directory', async status => {
    const f = await fixture()
    f.state.sessionControls = SessionControlStateSchema.parse({
      conversationId: f.conversation.id, revision: 0, profileKey: 'profile',
      desiredMode: 'regular', appliedMode: null, defaults: {}, desired: {}, applied: null,
      applicability: 'next-turn', capabilities: unavailableSessionControls('profile'), context: null,
      nativeSessionId: f.conversation.native_session_id, nativeProviderVersion: f.conversation.provider_version,
      compaction: { requestId: 'compact-command', nativeSessionId: f.conversation.native_session_id,
        nativeOperationId: null, status, message: 'Waiting for native compaction.', beforeTokens: null,
        observedAt: new Date().toISOString() },
      compactions: [], busyReason: null,
    })
    await rm(f.path, { recursive: true })
    await expect(f.send()).rejects.toMatchObject({ code: 'SESSION_COMPACT_UNCONFIRMED' })
    expect(f.state.turns).toHaveLength(0)
    expect(f.state.messages).toHaveLength(0)
    expect(f.state.sessionControls.revision).toBe(0)
  },
)

it('rejects an inactive steer before checking a missing chat directory', async () => {
  const f = await fixture()
  await rm(f.path, { recursive: true })
  await expect(f.repository.admit({
    key: f.conversation.agent_key, context: f.context, delivery: 'submitting',
    request: { requestId: randomUUID(), content: 'Steer', intent: 'steer', expectedConversationId: f.conversation.id,
      expectedNativeTurnId: 'finished-turn', context: { workflowId: f.context.workflowId,
        workflowNodeId: f.context.workflowNodeId, agentId: f.context.agentId } },
  })).rejects.toMatchObject({ code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
  expect(f.state.turns).toHaveLength(0)
  expect(f.state.messages).toHaveLength(0)
})

it('rejects a retained-folder follow-up when recursive removal wins admission', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'work.txt'), 'retained work')
  const folder = (await f.folders.list(principal, {})).items[0]!
  const checked = deferred()
  const release = deferred()
  f.state.readChatReferences = async () => {
    checked.resolve()
    await release.promise
  }
  const deleting = f.folders.delete(principal, 'http', {
    path: f.path, expectedIdentity: folder.identity, commandId: randomUUID(),
  })
  await checked.promise
  const sending = f.send().then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await Promise.race([sending, f.blocked.promise])
  } finally {
    release.resolve()
  }
  await deleting
  expect(await sending).toMatchObject({ error: { code: 'AGENT_CHAT_DIRECTORY_UNAVAILABLE' } })
  expect(f.state.turns).toHaveLength(0)
  expect(f.state.messages).toHaveLength(0)
  await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps retained-folder files when follow-up admission wins recursive removal', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'work.txt'), 'retained work')
  const entered = deferred()
  const release = deferred()
  f.state.beforeMessage = async () => {
    entered.resolve()
    await release.promise
  }
  const sending = f.send()
  await entered.promise
  const deleting = f.remove().then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await Promise.race([deleting, f.blocked.promise])
  } finally {
    release.resolve()
  }
  expect(await sending).toMatchObject({ turn: { delivery: 'queued' } })
  expect(await deleting).toMatchObject({ error: { code: 'DIRECTORY_IN_USE' } })
  expect(f.state.turns).toHaveLength(1)
  expect(await readFile(join(f.path, 'work.txt'), 'utf8')).toBe('retained work')
})

it('reads back a completed request after its retained directory is removed', async () => {
  const f = await fixture()
  const requestId = randomUUID()
  const admitted = await f.send(requestId)
  await rm(f.path, { recursive: true })
  expect(await f.send(requestId)).toMatchObject({ replayed: true, turn: admitted.turn })
  expect(f.state.turns).toHaveLength(1)
})

it('does not check a device conversation directory on the application host', async () => {
  const f = await fixture()
  f.state.hostKind = 'device'
  await rm(f.path, { recursive: true })
  expect(await f.send()).toMatchObject({ turn: { delivery: 'queued' } })
})

it.each(['sibling', 'device', 'receipt replay'] as const)(
  'admits an unrelated %s chat while recursive removal is paused', async kind => {
    const f = await fixture()
    const requestId = randomUUID()
    if (kind === 'receipt replay') await f.send(requestId)
    if (kind === 'device') f.state.hostKind = 'device'
    const other = join(f.root, 'other-project')
    await mkdir(other)
    const folder = (await f.folders.list(principal, {})).items.find(item => item.path === other)!
    const checked = deferred()
    const release = deferred()
    f.state.readChatReferences = async () => {
      checked.resolve()
      await release.promise
    }
    const deleting = f.folders.delete(principal, 'http', {
      path: other, expectedIdentity: folder.identity, commandId: randomUUID(),
    })
    await checked.promise
    const sending = f.send(requestId)
    try {
      const first = await Promise.race([
        sending.then(value => ({ value })),
        f.blocked.promise.then(() => ({ blocked: true })),
      ])
      expect(first).toMatchObject({ value: { replayed: kind === 'receipt replay', turn: { delivery: 'queued' } } })
    } finally {
      release.resolve()
      await deleting
      await sending
    }
    await expect(lstat(other)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('serializes a child chat folder with recursive removal of its parent', async () => {
  const f = await fixture()
  f.conversation.record.workingDirectory = join(f.path, 'child')
  await mkdir(f.conversation.record.workingDirectory)
  const folder = (await f.folders.list(principal, {})).items[0]!
  const checked = deferred()
  const release = deferred()
  f.state.readChatReferences = async () => {
    checked.resolve()
    await release.promise
  }
  const deleting = f.folders.delete(principal, 'http', {
    path: f.path, expectedIdentity: folder.identity, commandId: randomUUID(),
  })
  await checked.promise
  const sending = f.send().then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await Promise.race([sending, f.blocked.promise])
  } finally {
    release.resolve()
  }
  await deleting
  expect(await sending).toMatchObject({ error: { code: 'AGENT_CHAT_DIRECTORY_UNAVAILABLE' } })
  expect(f.state.turns).toHaveLength(0)
  expect(f.state.messages).toHaveLength(0)
})

it.each(['rename', 'delete', 'undo'] as const)(
  'protects overlapping active chat and Run directories from folder-picker %s', async action => {
    for (const source of ['chat', 'run'] as const) {
      for (const overlap of ['same', 'parent', 'child'] as const) {
        const f = await fixture()
        const creationCommandId = randomUUID()
        const folder = (await f.browser.create(principal, 'http', {
          parentPath: f.root, name: 'active-folder', commandId: creationCommandId,
        })).value
        let retainedPath = folder.path
        if (overlap === 'parent') retainedPath = f.root
        if (overlap === 'child') retainedPath = join(folder.path, 'working')
        if (source === 'chat') {
          await f.send()
          f.conversation.record.workingDirectory = retainedPath
        } else {
          f.state.runDirectories.push({ path: retainedPath })
        }
        if (action === 'delete') {
          expect(await f.browser.deleteFolders(principal, 'http', { paths: [folder.path], commandId: randomUUID() }))
            .toMatchObject({ value: { deleted: [], failed: [{ path: folder.path, message: expect.any(String) }] } })
        } else if (action === 'rename') {
          await expect(f.browser.renameCreated(principal, 'http', {
            path: folder.path, name: 'renamed', commandId: randomUUID(),
          })).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
        } else {
          await expect(f.browser.undoCreated(principal, 'http', { creationCommandId, commandId: randomUUID() }))
            .rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
        }
        expect((await lstat(folder.path)).isDirectory()).toBe(true)
      }
    }
  },
)

it.each(['rename', 'delete', 'undo'] as const)('protects an unfinished import from folder-picker %s', async action => {
  const f = await fixture()
  const creationCommandId = randomUUID()
  const folder = (await f.browser.create(principal, 'http', {
    parentPath: f.root, name: 'import-container', commandId: creationCommandId,
  })).value
  f.state.imports.push({ path: folder.path })
  if (action === 'delete') {
    expect(await f.browser.deleteFolders(principal, 'http', { paths: [folder.path], commandId: randomUUID() }))
      .toMatchObject({ value: { deleted: [], failed: [{ path: folder.path, message: expect.any(String) }] } })
  } else if (action === 'rename') {
    await expect(f.browser.renameCreated(principal, 'http', { path: folder.path, name: 'renamed', commandId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  } else {
    await expect(f.browser.undoCreated(principal, 'http', { creationCommandId, commandId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  }
  expect((await lstat(folder.path)).isDirectory()).toBe(true)
  f.state.imports.length = 0
  expect(await f.browser.deleteFolders(principal, 'http', { paths: [folder.path], commandId: randomUUID() }))
    .toMatchObject({ value: { deleted: [folder.path], failed: [] } })
})

it.each(['create', 'rename'] as const)('keeps a reserved import destination available during folder %s', async action => {
  const f = await fixture()
  const destination = join(f.root, 'import-container')
  f.state.imports.push({ path: destination })
  const mutation = action === 'create'
    ? f.browser.create(principal, 'http', { parentPath: f.root, name: 'import-container', commandId: randomUUID() })
    : f.browser.renameCreated(principal, 'http', { path: f.path, name: 'import-container', commandId: randomUUID() })
  await expect(mutation).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await lstat(f.path)).isDirectory()).toBe(true)
})
