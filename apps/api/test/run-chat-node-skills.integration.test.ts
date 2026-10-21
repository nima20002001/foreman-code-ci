import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, type ResolvedSkill } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeHarnessSessionManager, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { sessionStartConfiguration } from '../src/modules/harnesses/sessionStart.js'
import { agentInstructionBundle } from '../src/modules/skills/instructions.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { eventually } from './helpers/agentChatF5.js'
import { agent3Database, candidateFor, seedAgent3 } from './helpers/wave25Agent3.js'

function skill(skillId: string, instructions: string): ResolvedSkill {
  return { skillId, version: '1', instructions,
    contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}` }
}

it.each(['fork', 'recovery'] as const)('keeps the originating node skills during Claude chat %s', async phase => {
  const db = await agent3Database()
  const services: AgentChatService[] = []
  try {
    const skills = [skill('shared', 'Shared guidance'), skill('removed', 'Removed guidance'),
      skill('added', 'Node-only guidance')]
    const reference = (index: number) => ({ skillId: skills[index]!.skillId, version: '1' })
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    fixture.configurations = fixture.configurations.map(configuration => AgentConfigurationVersionSchema.parse({
      ...configuration, instructionDelivery: 'native-v1', assignedSkills: [reference(0), reference(1)],
      resolvedSkills: skills.slice(0, 2), harness: { harness: 'claude', model: 'fixture', authMode: 'subscription',
        configDirectory: db.directory, permissionMode: 'default', sandbox: 'danger-full-access',
        tools: [], permissionRules: [], instructions: '', mcpServers: {} },
    }))
    fixture.version.definition.nodes[0]!.skills = { remove: ['removed'], add: [reference(2)] }
    const saved = await seedAgent3(db.pool, db.directory, fixture, { skills })
    const candidate = candidateFor(saved)
    await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,1,$5::jsonb)`,
    [candidate.id, candidate.runId, candidate.workflowNodeId, candidate.agentId, JSON.stringify(candidate)])
    const source = HarnessExecutionSchema.parse({ ...candidate, state: 'completed',
      nativeSessionId: 'source-session', workingDirectory: db.directory,
      result: { outcome: 'succeeded', output: {} }, finishedAt: saved.createdAt })
    const run = AcceptedWorkflowRunV3Schema.parse({ ...saved.run, executionState: 'completed',
      outcome: 'succeeded', result: { outcome: 'succeeded', output: {} }, finishedAt: saved.createdAt })
    const runs: Pick<PostgresRunRepository, 'getForWorkspace' | 'getExecution' | 'executionPages'> = {
      getForWorkspace: async () => run,
      getExecution: async () => source, async *executionPages() { yield [source] } }
    const repository = new PostgresAgentChatRepository(db.pool)
    const owner = await new PostgresAccessService(db.pool).issue({ name: 'Chat writer', audience: 'operator',
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000) })
    const context = { workflowId: saved.scope.workflowId, runId: saved.run.id,
      workflowNodeId: source.workflowNodeId, agentId: source.agentId }
    const prompts: Array<{ operation: string; text: string; delivered: boolean }> = []
    const makeService = (recovering: boolean) => {
      const session = { harness: 'claude' as const, providerVersion: 'fixture', nativeSessionId: 'chat-session' }
      const capture = (operation: string, input: NativeSessionStart) => {
        prompts.push({ operation, text: agentInstructionBundle(sessionStartConfiguration(input))!.text,
          delivered: input.kind === 'agent-chat' && input.instructionsDelivered === true })
        return session
      }
      // Only the native lifecycle operations exercised by fork and recovery are supplied.
      const native = {
        harness: 'claude',
        capabilities: async () => ({ provider: 'claude', providerVersion: 'fixture', persistentSessions: true,
          reconnect: true, sameRequestResponses: true, cancellation: true, history: true,
          configurationInspection: false, mcpDetection: false, supportedInteractionKinds: [] }),
        forkSession: async (_source, input) => capture('fork', input),
        attachSession: async (_session, input) => capture('attach', input),
        async *startTurn(_session, input) { await input.onSubmitted?.('follow-up-turn'); yield* [] },
        reconcile: async (_session, correlationId) => ({ correlationId,
          events: [], pendingInteractions: [], nativeTurnId: 'follow-up-turn',
          ...(recovering ? { terminalResult: { outcome: 'succeeded' as const } } : {}) }),
        pending: async () => undefined,
        dispose: async () => undefined,
      } satisfies Partial<NativeHarnessSessionManager>
      const service = new AgentChatService(db.pool, repository, new PostgresOperatorConversationRepository(db.pool),
        new PostgresWorkflowRepository(db.pool), runs, () => native as unknown as NativeHarnessSessionManager, db.directory)
      services.push(service)
      return service
    }
    const first = makeService(false)
    const response = await first.send(owner.principal, saved.scope.workspaceId, {
      requestId: 'follow-up', content: 'Continue', intent: 'next_turn', context, expectedConversationId: null,
    })
    const id = response.state.conversation!.id
    await eventually(async () => (await repository.turn(id, 'follow-up'))?.nativeTurnId === 'follow-up-turn')
    if (phase === 'recovery') {
      await first.shutdown()
      // The mutable catalog is unavailable; the saved Run version retains the added instructions.
      await db.pool.query('update workspace_skills set archived_at=now() where workspace_id=$1', [saved.scope.workspaceId])
      await makeService(true).recover()
      await eventually(async () => (await repository.turn(id, 'follow-up'))?.delivery === 'completed')
    }
    const prompt = prompts.find(entry => entry.operation === (phase === 'fork' ? 'fork' : 'attach'))!
    expect(prompt).toBeDefined()
    expect(prompt.delivered).toBe(true)
    expect(prompt.text).toContain('Shared guidance')
    expect(prompt.text).toContain('Node-only guidance')
    expect(prompt.text).not.toContain('Removed guidance')
    expect((await new PostgresWorkflowRepository(db.pool).getAgentConfiguration(saved.configurations[0]!.id))
      ?.assignedSkills).toEqual([reference(0), reference(1)])
  } finally {
    for (const service of services.reverse()) await service.shutdown()
    await db.close()
  }
}, 30_000)
