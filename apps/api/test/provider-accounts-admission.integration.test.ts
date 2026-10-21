import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { LocalProviderCredentials } from '../src/modules/provider-accounts/localCredentials.js'
import { ProviderAccountsRepository } from '../src/modules/provider-accounts/repository.js'
import { ProviderAccountsService, type ProviderAccountOperationNativePort } from '../src/modules/provider-accounts/service.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { RunHistoryService } from '../src/modules/runs/history.js'
import { PostgresAgentChatRepository, agentConversation, agentChatKey } from '../src/modules/conversations/agentChatRepository.js'

it('pins queued Start and both fresh and source-Run conversation admissions before the default changes', async () => {
  const db = await migratedDatabase()
  try {
    const access = new PostgresAccessService(db.pool)
    const owner = await access.issue({ name: 'Admission caller', audience: 'operator', expiresAt: new Date('2099-01-01'),
      grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage', 'runs:start', 'runs:read',
        'workflows:read', 'agents:read', 'workspace_locations:read', 'workspace_locations:update'], scope: {} }] })
    const credentials = new LocalProviderCredentials(join(db.directory, 'accounts'))
    const commands = new PostgresCommandCoordinator(db.pool)
    const native: ProviderAccountOperationNativePort = { status: async () => ({ status: 'signed-in', identity: null }),
      login: async () => {}, logout: async () => {}, cancelLogin: async () => {}, close: async () => {} }
    const service = () => new ProviderAccountsService(db.pool, new ProviderAccountsRepository(db.pool,
      () => credentials.hostId()), credentials, native, commands)
    const accounts = service()
    const create = (name: string, revision: number) => accounts.create(owner.principal, 'http', {
      commandId: randomUUID(), expectedRevision: revision, provider: 'codex', authMode: 'subscription', name,
    })
    const first = (await create('A', 0)).value.accounts[0]!
    const second = (await create('B', 1)).value.accounts[1]!
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    for (const configuration of fixture.configurations) {
      if (configuration.harness.harness !== 'codex') throw new Error('This fixture requires Codex')
      configuration.harness = { ...configuration.harness, accountId: first.id }
    }
    await seedAgent3(db.pool, db.directory, fixture, { run: false })
    const locations = new WorkspaceLocationService(db.pool, commands)
    const location = (await locations.set(owner.principal, 'http', { workspaceId: fixture.scope.workspaceId,
      commandId: randomUUID(), expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: db.directory })).value
    const head = (await db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1',
      [fixture.scope.workflowId])).rows[0]!
    const request = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
      workflowVersionId: fixture.version.id, executionSemanticsVersion: 3 as const, commandId: randomUUID(),
      expectedWorkflowRevision: Number(head.revision), expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
      expectedLocationRevision: location.locationRevision, input: {} }
    const originalConfigurations = (await db.pool.query<{ record: unknown }>(
      'select record from agent_configuration_versions where workspace_id=$1 order by id', [fixture.scope.workspaceId])).rows
    const accepted = await admitRepeatRun(db.pool, locations, owner.principal, 'http', request,
      { ...repeatStartPublication, accountBindings: accounts.acceptedBindings })
    expect(accepted.value.executionState).toBe('queued')
    await accounts.setDefault(owner.principal, 'mcp', second.id, { commandId: randomUUID(), expectedRevision: 2 })
    const replay = await admitRepeatRun(db.pool, locations, owner.principal, 'mcp', request,
      { ...repeatStartPublication, accountBindings: service().acceptedBindings })
    expect(replay).toEqual({ value: accepted.value, replayed: true })
    const snapshot = (await new RunHistoryService(db.pool).snapshot(owner.principal,
      { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, runId: accepted.value.id })).snapshot
    if (snapshot.kind !== 'available') throw new Error('Start must capture its board/account bindings')
    const entry = fixture.version.definition.nodes[0]!
    expect(snapshot.providerAccountBindings?.[entry.id]).toEqual(first.binding)
    const configuration = fixture.configurations.find(value => value.agentId === ('agentId' in entry ? entry.agentId : ''))!
    const sourceExecution = HarnessExecutionSchema.parse({ id: randomUUID(), runId: accepted.value.id,
      workflowNodeId: entry.id, agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
      attempt: 1, input: {}, state: 'completed', result: { outcome: 'succeeded' },
      nativeSessionId: 'source-native-session', workingDirectory: db.directory,
      createdAt: fixture.createdAt, finishedAt: fixture.createdAt })
    await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`, [sourceExecution.id, sourceExecution.runId, sourceExecution.workflowNodeId,
      sourceExecution.agentId, sourceExecution.attempt, JSON.stringify(sourceExecution)])
    expect(await service().runtimeBinding('run-node', `${accepted.value.id}:${entry.id}`, configuration.harness))
      .toEqual(first.binding)
    const conversations = new PostgresAgentChatRepository(db.pool, accounts.acceptedBindings)
    const context = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
      workflowNodeId: entry.id, agentId: configuration.agentId }
    const createChat = async (source: boolean) => {
      const selected = source ? { ...context, runId: accepted.value.id } : context
      const row = await conversations.ensureForControls(agentChatKey(selected), { context: selected,
        agentConfigurationVersionId: configuration.id, harness: 'codex', workingDirectory: db.directory,
        runtimeDirectory: db.directory, origin: source ? { kind: 'run_execution', runId: accepted.value.id,
          executionId: sourceExecution.id, sourceNativeSessionId: sourceExecution.nativeSessionId! } : { kind: 'fresh' } },
      async () => {})
      const publicConversation = agentConversation((await conversations.get(row.id))!)
      expect(publicConversation.providerAccountBinding).toEqual(first.binding)
      expect(publicConversation.nativeSession).toBeNull()
      return row
    }
    await createChat(false)
    const sourceChat = await createChat(true)
    await accounts.remove(owner.principal, 'http', first.id, { commandId: randomUUID(), expectedRevision: 3 })
    expect(agentConversation((await conversations.get(sourceChat.id))!).providerAccountBinding).toEqual(first.binding)
    await expect(service().resolve('codex', first.id, { acceptedBinding: first.binding! }))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' })
    expect((await db.pool.query<{ record: unknown }>(
      'select record from agent_configuration_versions where workspace_id=$1 order by id', [fixture.scope.workspaceId])).rows)
      .toEqual(originalConfigurations)
  } finally { await db.close() }
}, 30_000)
