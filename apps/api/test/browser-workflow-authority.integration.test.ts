import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { canonicalJson, effectiveGraphqlTools, type AgentSubject, type AgentConfigurationVersion, type NodeBrowserSettings, type ResolvedSkill } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import type { NodeSkillOverride } from '@foreman-code/contracts/wave25'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { workflowSettlementFixture } from './helpers/workflowSettlementFixture.js'
import { BrowserAuthority } from '../src/modules/collaboration/browserAuthority.js'
import { browserAgentTools } from '../src/modules/collaboration/browserTools.js'
import { createBrowserProfileRepository } from '../src/modules/browser-profiles/repository.js'
import { readWorkflowChatAgent } from '../src/modules/collaboration/workflowChatIdentity.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { agentInstructionBundle } from '../src/modules/skills/instructions.js'
import { requestRepeatRunStop } from '../src/modules/runs/repeatLifecycle.js'
import { createProductionBrowser } from '../src/modules/collaboration/browserComposition.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const fixtures: Awaited<ReturnType<typeof workflowSettlementFixture>>[] = []
beforeAll(async () => { db = await currentDatabase() })
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close() })
afterAll(async () => { await db.close() })

async function savedBrowser() {
  const f = await workflowSettlementFixture(db, graph => ({ ...graph, handoffs: { contractVersion: 1 },
    nodes: graph.nodes.map(node => ({ ...node, browser: { enabled: true, profileId: 'profile' },
      graphqlTools: { add: [], remove: ['browser_action'] } })),
  }), 'single')
  fixtures.push(f)
  const activation = await f.store.ensureWorkEntry()
  const { execution } = await f.store.admitWorkActivation(activation, nodeId => f.candidate(nodeId))
  const agent = await readWorkflowChatAgent(db.pool, f.version, execution.workflowNodeId)
  const subject: AgentSubject = { kind: 'execution', agent, execution: {
    runId: f.run.id, workflowVersionId: f.version.id, executionId: execution.id,
    attempt: execution.attempt, activationId: activation,
  } }
  const authority = new BrowserAuthority(db.pool, () => 'computer', () => createBrowserProfileRepository(db.pool), async () => true)
  return { ...f, execution, subject, authority }
}

it('saves Browser tool defaults and a pinned managed skill while preserving an explicit tool restriction', async () => {
  const f = await savedBrowser()
  const repository = new PostgresWorkflowRepository(db.pool)
  const version = (await repository.getSavedVersion(f.version.id))!
  const node = version.definition.nodes.find(item => item.id === f.execution.workflowNodeId)!
  if (node.kind === 'job') throw new Error('Expected an Agent')
  const configuration = (await repository.getAgentConfiguration(version.agentConfigurationVersionIds[node.agentId]!))!
  const tools = effectiveGraphqlTools(configuration.productRole!, configuration.graphqlTools, node.graphqlTools, false, browserAgentTools)
  expect(tools).toContain('browser_state_read')
  expect(tools).toContain('browser_tab_create')
  expect(tools).not.toContain('browser_action')
  const snapshot = version.nodeSkillSnapshots?.[node.id]?.find(skill => skill.skillId === 'foreman-browser-use')
  expect(snapshot).toMatchObject({ skillId: 'foreman-browser-use', contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
  const resolve: (configuration: AgentConfigurationVersion, override: NodeSkillOverride | undefined,
    additions: readonly ResolvedSkill[] | undefined, browser: NodeBrowserSettings | undefined) => Promise<AgentConfigurationVersion>
    = repository.resolveNodeSkills.bind(repository)
  const effective = await resolve(configuration, node.skills, version.nodeSkillSnapshots?.[node.id], node.browser)
  expect(agentInstructionBundle(effective)?.text).toContain(snapshot!.instructions)
  expect((await repository.getSavedVersion(version.id))?.nodeSkillSnapshots?.[node.id]).toEqual(version.nodeSkillSnapshots?.[node.id])
})

it('pins the managed browser skill independently of workspace skill assignments', async () => {
  const f = await savedBrowser()
  const version = await new PostgresWorkflowRepository(db.pool).getSavedVersion(f.version.id)
  expect(version?.nodeSkillSnapshots?.[f.execution.workflowNodeId]).toEqual(expect.arrayContaining([
    expect.objectContaining({ skillId: 'foreman-browser-use', instructions: expect.any(String),
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }),
  ]))
})

it('checks a prepared browser owner with one live read and rejects it immediately after Stop', async () => {
  const f = await savedBrowser()
  await f.authority.details(f.subject)
  const queries = vi.spyOn(db.pool, 'query')
  await expect(f.authority.assertCurrent(f.subject)).resolves.toBeUndefined()
  expect(queries).toHaveBeenCalledTimes(1)
  queries.mockRestore()
  await requestRepeatRunStop(db.pool, f.run.id, async () => undefined)
  await expect(f.authority.assertCurrent(f.subject)).rejects.toMatchObject({ code: 'BROWSER_SUBJECT_SETTLED' })
})

it('authorizes an execution browser with its Run-scoped Operator grant and denies another Run', async () => {
  const f = await savedBrowser()
  const access = new PostgresAccessService(db.pool)
  const owner = await access.issue({ name: 'Run browser Operator', audience: 'operator', grants: [{
    actions: ['workflows:read', 'workflows:update'], scope: { runIds: [f.run.id] },
  }] })
  await expect(f.authority.subject(owner.principal, f.subject, false)).resolves.toBeUndefined()
  await expect(f.authority.subject(owner.principal, f.subject, true)).resolves.toBeUndefined()
  const denied = await access.issue({ name: 'Different Run Operator', audience: 'operator', grants: [{
    actions: ['workflows:read', 'workflows:update'], scope: { runIds: ['different-run'] },
  }] })
  await expect(f.authority.subject(denied.principal, f.subject, false)).rejects.toMatchObject({ status: 403 })
})

it('resolves a saved conversation browser selection before its first native turn', async () => {
  const f = await conversationDeliveryFixture()
  try {
    const state = await f.agent.ensureConversation(f.owner, { workspaceId: f.scope.workspaceId, ...f.query })
    if (!state.conversation) throw new Error('Expected the saved conversation')
    const authority = new BrowserAuthority(f.database.pool, () => 'computer',
      () => createBrowserProfileRepository(f.database.pool), async () => true)
    const selected = await authority.conversation(state.conversation.id)
    await expect(authority.details(selected.context.subject)).resolves.toMatchObject({
      active: true, browser: { enabled: false }, subject: { kind: 'conversation', conversationId: state.conversation.id },
    })
  } finally { await f.close() }
})

it('bounds cached browser configurations and reloads an evicted active owner', async () => {
  const first = await savedBrowser()
  const second = await savedBrowser()
  const details = await first.authority.details(first.subject)
  const authority = new BrowserAuthority(db.pool, () => 'computer', () => createBrowserProfileRepository(db.pool),
    async () => true, { maxCachedBytes: Buffer.byteLength(canonicalJson(details))
      + Buffer.byteLength(canonicalJson(first.subject)) + 256 })
  await authority.details(first.subject)
  const queries = vi.spyOn(db.pool, 'query')
  await authority.details(first.subject)
  expect(queries).toHaveBeenCalledTimes(1)
  queries.mockRestore()
  await authority.details(second.subject)
  const reloaded = vi.spyOn(db.pool, 'query')
  expect(await authority.details(first.subject)).toMatchObject({ active: true, subject: first.subject })
  expect(reloaded.mock.calls.length).toBeGreaterThan(1)
})

it('evicts a released browser owner only after its host confirms cleanup', async () => {
  const f = await savedBrowser()
  const mainId = randomUUID(), deviceId = randomUUID(), installationId = randomUUID()
  await db.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
    values($1,$2,$3,$4,$5::jsonb)`, [deviceId, mainId, installationId, 'fixture-public-key', JSON.stringify({
    mainId, deviceId, workerInstallationId: installationId, publicKeyFingerprint: 'b'.repeat(64), keyRevision: 1,
    authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat', 'metrics:report'],
  })])
  let closed = false
  const unused = async (): Promise<never> => { throw new Error('This lifecycle fixture does not admit browser input.') }
  const browser = createProductionBrowser({ pool: db.pool, stateDirectory: db.directory, binding: () => null,
    assertHostOwnership: async () => undefined, reportFailure: () => undefined,
    remote: () => ({ profiles: { endpoint: unused }, sessions: { invoke: unused }, ready: async () => true,
      media: () => { throw new Error('This lifecycle fixture does not open media.') }, prepare: unused,
      release: async input => ({ sessionId: input.sessionId, state: closed ? 'closed' : 'pending', reason: null }),
    }) })
  await browser.start(mainId)
  try {
    await browser.authority.details(f.subject)
    await browser.locations.save({ id: 'remote-browser', subject: f.subject, profileId: 'profile',
      computerId: deviceId, browserGeneration: 1, state: 'ready', selectedTabId: null }, installationId)
    const input = { sessionId: 'remote-browser', subject: f.subject, commandId: 'release-browser', reason: 'runtime_update' as const }
    expect(await browser.lifecycle.release(input)).toMatchObject({ state: 'pending' })
    const queries = vi.spyOn(db.pool, 'query')
    await browser.authority.details(f.subject)
    expect(queries).toHaveBeenCalledTimes(1)
    closed = true
    await browser.lifecycle.release(input)
    queries.mockClear()
    await browser.authority.details(f.subject)
    expect(queries.mock.calls.length).toBeGreaterThan(1)
  } finally { await browser.stop() }
})
