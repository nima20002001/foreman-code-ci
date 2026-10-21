import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerSyncService } from '../src/modules/computers/sync.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { workerSyncId } from './helpers/syncthing.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
let principal: ManagementPrincipal
let mainId: string
let targets: DeviceProvisioningTarget[]
beforeAll(async () => {
  database = await migratedDatabase()
  mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  principal = (await new PostgresAccessService(database.pool).issue({ name: 'Sync reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['settings:read'], scope: {} }] })).principal
  targets = await Promise.all([1, 2].map(async () => {
    const record = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
    await database.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [record.deviceId, mainId, record.workerInstallationId, JSON.stringify(record)])
    return { hostRef: { kind: 'device' as const, mainId, deviceId: record.deviceId },
      applicationInstallationId: record.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  }))
})
afterAll(async () => { await database?.close() })

it.each([
  { delivery: 'queued', change: 'moved' }, { delivery: 'active', change: 'moved' },
  { delivery: 'queued', change: 'archived' }, { delivery: 'active', change: 'archived' },
])('keeps the original computer in sync for a $delivery chat after its Agent is $change', async ({ delivery, change }) => {
  const workspaceId = randomUUID()
  const agentId = randomUUID()
  const old = workerConversationFixture('agent').configuration
  if (!('agentId' in old)) throw new Error('Expected Agent configuration')
  const target = targets[0]!
  const selection = { ...old.harnessProfileSelection!, target: {
    ...old.harnessProfileSelection!.target, hostRef: target.hostRef,
    applicationInstallationId: target.applicationInstallationId,
  } }
  const configuration = { ...old, workspaceId, agentId, harnessProfileSelection: selection }
  await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Chat project' })])
  await database.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
    [agentId, workspaceId, JSON.stringify({ id: agentId, name: 'Chat Agent' })])
  await database.pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
    values($1,$2,$3,1,$4::jsonb)`, [configuration.id, workspaceId, agentId, JSON.stringify(configuration)])
  await database.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agentId, configuration.id])
  const context = { workspaceId, workflowId: randomUUID(), workflowNodeId: randomUUID(), agentId }
  const chats = new PostgresAgentChatRepository(database.pool)
  const requestId = randomUUID()
  const admitted = await chats.admit({ key: agentChatKey(context), context, delivery: 'queued',
    request: { requestId, content: 'Continue on the original computer', intent: 'next_turn', expectedConversationId: null,
      context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId } },
    create: { context, harness: 'codex', agentConfigurationVersionId: configuration.id, origin: { kind: 'fresh' },
      workingDirectory: database.directory, runtimeDirectory: database.directory } })
  if (delivery === 'active') expect(await chats.claim(admitted.conversationId, requestId)).toBe(true)
  if (change === 'moved') {
    const moved = { ...configuration, id: randomUUID(), version: 2, harnessProfileSelection: {
      ...selection, target: { ...selection.target, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId },
    } }
    await database.pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
      values($1,$2,$3,2,$4::jsonb)`, [moved.id, workspaceId, agentId, JSON.stringify(moved)])
    await database.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agentId, moved.id])
  } else {
    await database.pool.query('update agents set archived_at=clock_timestamp() where id=$1', [agentId])
  }
  // Only the external Syncthing status is synthetic; membership uses the migrated PostgreSQL tables.
  const state = { installed: true, running: true, deviceId: workerSyncId, folders: [], message: null }
  const sync = new ComputerSyncService(database.pool, mainId, () => ({
    capabilities: () => [{ namespace: 'computer-sync-v1', mainCanRequest: true }],
    request: async () => ({ payload: state }),
  }), new PostgresCommandCoordinator(database.pool), { handle: async () => state })
  const participating = async (computer: DeviceProvisioningTarget) =>
    (await sync.read(principal, 'http', { target: computer })).folders.find(folder => folder.workspaceId === workspaceId)!
  expect(await participating(target)).toMatchObject({ participating: true, enabled: true })
  expect(await participating(targets[1]!)).toMatchObject({ participating: false })
  if (delivery === 'queued') await chats.cancelQueued(admitted.conversationId, requestId)
  else await chats.finish(admitted.conversationId, requestId, { outcome: 'succeeded' })
  expect(await participating(target)).toMatchObject({ participating: false })
})
