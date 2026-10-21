import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { WorkflowNativeSessionStart } from '../../src/modules/harnesses/port.js'
import { RunSubagentSchema, subagentCapabilities, type RunSubagent,
  type RunSubagentCommandReceipt } from '@foreman-code/contracts/subagents'
import { CodexChildControls, type CodexChildControlHost } from '../../src/modules/harnesses/codexChildControls.js'
import { CodexRpcError, type JsonObject } from '../../src/modules/harnesses/codexStdioTransport.js'
import type { Thread, Turn } from '../../src/modules/harnesses/codexMethodTypes.js'
import { fixtureProtocol, nativeThread } from './codex-test-helpers.js'

export const childControlRecord = (overrides: Partial<RunSubagent> = {}) => RunSubagentSchema.parse({
  schemaVersion: 1, id: 'child', revision: '1', workspaceId: 'workspace', workflowId: 'workflow',
  workflowVersionId: 'version', runId: 'run', parentNodeId: 'node', parentAgentId: 'agent',
  parentExecutionId: 'execution', parentAttemptKey: 'execution:1', parentSubagentId: null,
  provider: 'codex', nativeMode: 'codex-multi-agent-v2',
  native: { parentSessionId: 'root', childSessionId: 'native-child', currentTurnId: 'child-turn' },
  profile: { deviceId: 'device', harnessInstanceId: 'instance', providerVersion: '0.154.0' },
  name: 'Child', status: 'running', evidence: 'confirmed', firstObservedAt: '2026-10-04T00:00:00.000Z',
  startedAt: '2026-10-04T00:00:00.000Z', finishedAt: null, lastObservedAt: '2026-10-04T00:00:00.000Z',
  coverage: { transcript: 'partial', tools: 'partial', gaps: true },
  capabilities: subagentCapabilities('codex-multi-agent-v2'), ...overrides,
})

export function childControlReceipt(child = childControlRecord(), overrides: Partial<RunSubagentCommandReceipt> = {}) {
  return { schemaVersion: 1 as const, id: 'receipt', principalId: 'principal', operation: 'run_subagent_input_v1' as const,
    commandId: 'command', workspaceId: child.workspaceId, runId: child.runId, subagentId: child.id,
    expectedRevision: child.revision, nativeGeneration: 'connection:0', nativeTurnId: child.native.currentTurnId ?? null,
    nativeCorrelationId: 'app-correlation', state: 'dispatching' as const,
    acceptedAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z', ...overrides }
}

function turn(id: string, status: Turn['status']): Turn {
  return { id, status, items: [], itemsView: 'full', error: null, startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2, durationMs: status === 'inProgress' ? null : 1 }
}

/** Recorded native boundary; every request and response uses the pinned production schemas. */
export function codexChildControlFixture(child = childControlRecord()) {
  let live = true
  let fail: string | undefined
  let requestId = 0
  const calls: { method: string; params: JsonObject }[] = []
  const target = child.native.childSessionId!
  const latest = turn(child.native.currentTurnId ?? 'child-turn', child.status === 'running' ? 'inProgress' : 'completed')
  const threads = new Map<string, Thread>()
  const addThread = (id: string, parent: string) => threads.set(id, nativeThread({ id, sessionId: id,
    parentThreadId: parent, source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1,
      agent_path: null, agent_nickname: null, agent_role: null } } },
    turns: id === target ? [latest] : [],
    status: child.status === 'running' ? { type: 'active', activeFlags: [] } : { type: 'notLoaded' },
  }))
  addThread(target, child.native.parentSessionId)
  if (child.native.parentSessionId !== 'root') addThread(child.native.parentSessionId, 'root')
  const host: CodexChildControlHost = {
    rootThreadId: 'root', generation: 'connection:0',
    qualified: { protocol: fixtureProtocol, providerVersion: 'codex-cli 0.154.0', schemaManifestSha256: 'fixture-schema' },
    assertCurrent() { if (!live) throw new Error('Owner lost') },
    exclusive: work => work(),
    transport: {
      async request(method, params = {}) {
        fixtureProtocol.request({ id: ++requestId, method, params })
        calls.push({ method, params })
        const thread = threads.get(String(params.threadId))!
        let result: unknown
        switch (method) {
          case 'thread/read': result = { thread }; break
          case 'thread/turns/list': result = { data: thread.turns.toReversed(), nextCursor: null }; break
          case 'thread/items/list': result = { data: thread.turns.flatMap(value => value.items.map(item => ({
            turnId: value.id, item,
          }))), nextCursor: null }; break
          case 'thread/resume':
            thread.status = { type: 'idle' }
            result = { thread, model: 'child-model', modelProvider: 'openai', serviceTier: null,
              cwd: thread.cwd, instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user',
              sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: 'medium',
              turnsBackwardsCursor: null, itemsBackwardsCursor: null }
            break
          case 'turn/start':
            thread.turns.push(turn('child-followup-turn', 'inProgress'))
            thread.status = { type: 'active', activeFlags: [] }
            result = { turn: thread.turns.at(-1)! }
            break
          case 'turn/steer': result = { turnId: thread.turns.at(-1)!.id }; break
          case 'turn/interrupt':
            thread.turns.at(-1)!.status = 'interrupted'
            result = {}
            break
          default: throw new Error(`Unexpected recorded method: ${method}`)
        }
        if (method === 'turn/start' || method === 'turn/steer') thread.turns.at(-1)!.items.push({
          type: 'userMessage', id: `native-item-${requestId}`, clientId: String(params.clientUserMessageId),
          content: params.input as Extract<Turn['items'][number], { type: 'userMessage' }>['content'],
        })
        fixtureProtocol.response(method, result)
        if (fail === method) {
          fail = undefined
          throw new CodexRpcError(method, requestId, true, 'CODEX_RPC_TIMEOUT')
        }
        return structuredClone(result)
      },
    },
  }
  const controller = new CodexChildControls()
  return { host, calls, threads, controller, lease: () => controller.lease(child, host, host.assertCurrent)!,
    loseOwner: () => { live = false }, failOnce: (method: string) => { fail = method } }
}

export async function seedCodexChild(directory: string, root: NativeSessionReference, source: WorkflowNativeSessionStart,
  overrides: Partial<RunSubagent> = {}) {
  const child = childControlRecord({ workspaceId: source.request.workspaceId,
    runId: source.request.runId, parentExecutionId: source.request.executionId,
    parentAttemptKey: `${source.request.executionId}:1`, parentNodeId: source.request.workflowNodeId,
    parentAgentId: source.request.configuration.agentId,
    native: { parentSessionId: root.nativeSessionId, childSessionId: 'native-child', currentTurnId: 'child-turn' },
    profile: { deviceId: 'device', harnessInstanceId: source.request.configuration.id, providerVersion: root.providerVersion },
    ...overrides,
  })
  const active = child.status === 'running'
  const nativeChild = nativeThread({ id: 'native-child', sessionId: 'native-child',
    parentThreadId: root.nativeSessionId, cwd: directory,
    source: { subAgent: { thread_spawn: { parent_thread_id: root.nativeSessionId, depth: 1,
      agent_path: null, agent_nickname: null, agent_role: null } } },
    status: active ? { type: 'active', activeFlags: [] } : { type: 'notLoaded' },
    turns: [{ id: 'child-turn', status: active ? 'inProgress' : 'completed',
      items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: active ? null : 2, durationMs: null }],
  })
  await writeFile(join(directory, 'state-native-child.json'), JSON.stringify({ ...nativeChild,
    settings: { model: 'child-model', modelProvider: 'openai', serviceTier: null, cwd: directory,
      reasoningEffort: 'medium', instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false } },
  }))
  return child
}
