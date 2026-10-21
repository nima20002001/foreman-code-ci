import { removeFixtureDirectory } from './helpers/testResources.js'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, type AgentConfigurationVersion, type NativeSessionReference } from '@foreman-code/contracts'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { closeQualificationResources } from '../src/modules/harnesses/qualification/cleanup.js'
import type { NativeHarnessSessionManager, AgentChatNativeSessionStart } from '../src/modules/harnesses/port.js'
import { readNativeSource } from './helpers/agentChatNativeSource.js'
import { describeNativeFailure, nativeFailureSummary } from './helpers/nativeFailureEvidence.js'

/**
 * Real installed Codex Agent chat through the production runtime factory.
 * Forking a finished session keeps its context and preserves the source session's history.
 * Opt in with RUN_REAL_HARNESS_TESTS=1.
 */
const enabled = process.env.RUN_REAL_HARNESS_TESTS === '1'
const binaries = harnessBinaries(process.env)

function configuration(): AgentConfigurationVersion {
  return AgentConfigurationVersionSchema.parse({
    id: `cfg-${randomUUID()}`, workspaceId: 'ws-native-chat', agentId: 'agent-native-chat', version: 1, productRole: 'coder',
    harness: { harness: 'codex', model: process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna',
        reasoningEffort: process.env.CODEX_TEST_REASONING_EFFORT ?? 'medium', sandbox: 'read-only', serviceTier: 'standard' },
    prompt: { system: 'Answer in at most five words.' }, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt: new Date().toISOString(),
  })
}
function start(config: AgentConfigurationVersion, directory: string, conversation: string, delivered: boolean): AgentChatNativeSessionStart {
  return { kind: 'agent-chat', conversationId: conversation, workflowId: 'workflow-native-chat',
    workflowNodeId: 'node-native-chat', correlationId: `agent-chat:${conversation}:${randomUUID()}`,
    instructionsDelivered: delivered, workingDirectory: directory, configuration: config }
}
async function turn(manager: NativeHarnessSessionManager, session: NativeSessionReference, conversation: string, prompt: string) {
  const correlation = `agent-chat:${conversation}:${randomUUID()}`
  for await (const event of manager.startTurn(session, { prompt, clientCorrelationId: correlation })) void event
  const history = await manager.reconcile(session, correlation)
  expect(history.terminalResult?.outcome,
    nativeFailureSummary({ failureExecutions: [{ result: history.terminalResult }] }, [])).toBe('succeeded')
  return { correlationId: correlation, history, text: JSON.stringify(history.terminalResult?.output ?? '') }
}

describe.skipIf(!enabled)('real native Agent chat fork', () => {
  for (const harness of ['codex'] as const) {
    it(`${harness}: fork keeps context in a new session and leaves the source unchanged`, async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), `agent-chat-${harness}-`)))
      const config = configuration()
      const registry = new NativeProcessRegistry(join(directory, 'native-processes'))
      const factories = new NativeHarnessFactories({ ...binaries,
        auxiliaryRecovery: role => registry.scope(`${role}:${randomUUID()}`),
        admitRecovery: async recovery => { Object.assign(recovery, await registry.reserveLaunch(recovery.owner)) },
        abandonRecovery: async recovery => { await registry.abandonReservedLaunch(recovery) },
        closeRecovery: async recovery => {
          if (!await registry.closeOwner(recovery.owner)) throw new Error('Native diagnostic closure is unconfirmed.')
        },
      })
      const make = (): NativeHarnessSessionManager => factories.allocate({
        harness, role: 'agent-chat', workingDirectory: directory, ownerAgentId: config.agentId, appMcpAccess: 'none',
        processRecovery: registry.scope(`agent-chat:${randomUUID()}`),
        configured: { instanceId: config.agentId, instanceRevision: config.id, driverId: harness,
          enabled: true, configuration: config.harness },
      }).manager
      const source = make()
      const forker = make()
      try {

        const sourceSession = await source.createSession(start(config, directory, 'source', false))
        const sourceTurn = await turn(source, sourceSession, 'source', 'Remember the codeword KIWI. Reply OK.')
        expect(sourceTurn.text).toMatch(/ok/i)
        expect(sourceTurn.history.nativeTurnId).toBeTruthy()
        const sourceBefore = await readNativeSource(sourceSession, directory)
        const fork = await forker.forkSession!(sourceSession, start(config, directory, 'fork', true))
        expect(fork.nativeSessionId).not.toBe(sourceSession.nativeSessionId)
        const forkTurn = await turn(forker, fork, 'fork', 'What codeword did I ask you to remember? One word.')
        expect(forkTurn.text).toMatch(/kiwi/i)
        const unchanged = await source.reconcile(sourceSession, sourceTurn.correlationId)
        expect(unchanged.nativeTurnId).toBe(sourceTurn.history.nativeTurnId)
        expect(unchanged.nativeMessageId).toBe(sourceTurn.history.nativeMessageId)
        expect(unchanged.terminalResult).toEqual(sourceTurn.history.terminalResult)
        // Compare full persisted records; resident diagnostic events may arrive after completion.
        expect(await readNativeSource(sourceSession, directory)).toBe(sourceBefore)
      } catch (error) {
        const secrets = Object.entries(process.env).filter(([name]) => /TOKEN|KEY|PASSWORD|SECRET/.test(name))
          .map(([, value]) => value).filter((value): value is string => Boolean(value))
        console.error(`Native fork failure ${JSON.stringify(describeNativeFailure(error, secrets))}`)
        throw error
      } finally {
        factories.stopAuxiliaries()
        try {
          await closeQualificationResources([
            { close: async () => { await source.dispose?.() } },
            { close: async () => { await forker.dispose?.() } },
            { close: () => factories.disposeAuxiliaries() },
          ])
        } finally {
          await removeFixtureDirectory(directory)
        }
      }
    }, 240_000)
  }
})
