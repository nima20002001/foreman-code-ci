import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { freezePlacement } from '../src/modules/placement/binding.js'
import { insertAcceptedPlacements } from '../src/modules/placement/persistence.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { WorkspaceStorageFolders } from '../src/modules/workspaces/storageFolders.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { sourceWorktreeMcpFixture } from './helpers/sourceWorktreeMcpFixture.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
let principal: ManagementPrincipal
let commands: PostgresCommandCoordinator
beforeAll(async () => {
  database = await migratedDatabase()
  commands = new PostgresCommandCoordinator(database.pool)
  principal = (await new PostgresAccessService(database.pool).issue({ name: 'Storage owner', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: [
      'workspaces:read', 'workspaces:archive', 'workspace_locations:read', 'workspace_locations:provision',
      'workflows:read', 'graph:read',
    ], scope: {} }] })).principal
})
afterAll(async () => { await database?.close() })

async function workspace() {
  const directory = join(database.directory, randomUUID())
  const storage = join(directory, 'storage')
  const registered = join(directory, 'registered')
  await mkdir(storage, { recursive: true })
  await mkdir(registered)
  const fixture = await seedAgent3(database.pool, registered, makeCurrentWorkflowFixture(randomUUID(), 'single'),
    { run: false })
  const path = join(storage, 'active-project')
  await mkdir(path)
  await writeFile(join(path, 'work.txt'), 'Keep active work')
  return { fixture, path, storage, folders: new WorkspaceStorageFolders(database.pool, commands, storage) }
}

async function checkFolders(folders: WorkspaceStorageFolders, owner: ManagementPrincipal, activePath: string) {
  const unusedPath = join(dirname(activePath), 'unused-project')
  await mkdir(unusedPath)
  await writeFile(join(unusedPath, 'unused.txt'), 'Disposable')
  const listed = await folders.list(owner, {})
  const unused = listed.items.find(item => item.path === unusedPath)!
  const active = listed.items.find(item => item.path === activePath)!
  expect(unused.deletion).toEqual({ status: 'available' })
  expect((await folders.delete(owner, 'http', { commandId: randomUUID(), path: unusedPath, expectedIdentity: unused.identity })).value)
    .toEqual({ path: unusedPath })
  await expect(lstat(unusedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect.soft(active.deletion).toMatchObject({ status: 'protected', reason: 'active_run' })
  await expect(folders.delete(owner, 'http', { commandId: randomUUID(), path: activePath, expectedIdentity: active.identity }))
    .rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  expect((await lstat(activePath)).isDirectory()).toBe(true)
  expect(await readFile(join(activePath, 'work.txt'), 'utf8')).toBe('Keep active work')
}

it.each(['queued Run', 'pending cleanup'])('protects a separately placed Agent directory used by a %s', async state => {
  const f = await workspace()
  const workflows = new WorkflowManagementService(database.pool, commands)
  const saved = await workflows.current.read(principal, {
    workspaceId: f.fixture.run.workspaceId, workflowId: f.fixture.run.workflowId,
  })
  const authorizationPrincipalId = f.fixture.run.authorizationPrincipalId
  if (!authorizationPrincipalId) throw new Error('Run fixture requires its authorization principal')
  const draft = await insertCurrentRunFixture(database.pool, f.fixture, saved, authorizationPrincipalId,
    { insert: false })
  const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  const node = agentWorkflowNode(draft.version.definition.nodes[0])
  const hash = 'a'.repeat(64)
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: draft.run.id,
    nodeId: node.id, hostRef: { kind: 'main', mainId }, registration: null,
    destination: { canonicalProjectRoot: f.path, canonicalCwd: f.path, managedRuntimeRoot: join(database.directory, 'runtime'),
      directoryIdentityHash: hash, rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1',
      attestationId: randomUUID(), attestationHash: hash },
    source: { kind: 'pending', approvedSourceId: randomUUID(), snapshotId: randomUUID(), revisionId: randomUUID(),
      manifestDigest: hash, rootId: randomUUID(), bindingRevision: 1, materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: node.agentId, agentConfigurationVersionId: draft.run.agentConfigurationVersionIds[node.agentId]!,
      driverId: 'codex', driverRevision: '1', instanceId: 'fixture', instanceRevision: '1', harnessInstallationId: 'fixture',
      installationFingerprint: hash, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  await withExclusiveGraphConnection(database.pool, connection => connection.transaction(async sql => {
    await insertRepeatRun(sql, draft.accepted, repeatStartPublication)
    await insertAcceptedPlacements(sql, draft.run.id, [node], draft.run.agentConfigurationVersionIds, [placement],
      { assertCurrent: async () => {} })
  }))
  if (state === 'pending cleanup') {
    await database.pool.query(`update runs set execution_state='completed',
      record=record || $2::jsonb where id=$1`, [draft.run.id,
    JSON.stringify({ executionState: 'completed', outcome: 'canceled', finishedAt: new Date().toISOString() })])
    await database.pool.query('insert into run_cleanup_intents(run_id,pending) values($1,true)', [draft.run.id])
  }
  await checkFolders(f.folders, principal, f.path)
})

it.each(['queued', 'active'])('protects an unregistered directory retained by a %s Agent conversation', async state => {
  const f = await workspace()
  const configuration = f.fixture.configurations[0]!
  const node = agentWorkflowNode(f.fixture.version.definition.nodes[0])
  const context = { workspaceId: f.fixture.run.workspaceId, workflowId: f.fixture.run.workflowId,
    workflowNodeId: node.id, agentId: node.agentId }
  const chats = new PostgresAgentChatRepository(database.pool)
  const requestId = randomUUID()
  const admitted = await chats.admit({ key: agentChatKey(context), context, delivery: 'queued',
    request: { requestId, content: 'Continue working', intent: 'next_turn', expectedConversationId: null,
      context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId } },
    create: { context, harness: 'codex', agentConfigurationVersionId: configuration.id, origin: { kind: 'fresh' },
      workingDirectory: f.path, runtimeDirectory: join(database.directory, 'runtime') } })
  if (state === 'active') expect(await chats.claim(admitted.conversationId, requestId)).toBe(true)
  await checkFolders(f.folders, principal, f.path)
})

it('protects the native materialization directory of an executing Run', async () => {
  const f = await sourceWorktreeMcpFixture()
  try {
    const started = await f.client.callTool({ name: 'run_start', arguments: { ...f.input, commandId: randomUUID() } })
    expect(started.isError, JSON.stringify(started)).not.toBe(true)
    const runId = RunStartV3ResultSchema.parse(decodeMcpToolResult(started)).run.id
    await expect.poll(async () => (await f.base.runs.get(runId))?.executionState, { timeout: 90_000 }).toBe('waiting')
    const native = (await f.base.db.pool.query<{ path: string }>(`select record#>>'{workingTree,canonicalProjectRoot}' as path
      from execution_native_placements where record->>'runId'=$1 order by execution_id limit 1`, [runId])).rows[0]!
    await writeFile(join(native.path, 'work.txt'), 'Keep active work')
    const folders = new WorkspaceStorageFolders(f.base.db.pool, f.base.commands, dirname(native.path))
    await checkFolders(folders, f.base.writer.principal, native.path)
  } finally { await f.close() }
}, 120_000)
