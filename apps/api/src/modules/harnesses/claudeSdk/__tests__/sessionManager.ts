import { vi, type Mock } from 'vitest'
import type { NativeSessionStart } from '../../port.js'
import type { HarnessExecutionRequest } from '@foreman-code/contracts'
import { ClaudeBoundedQueue } from '../queue.js'
import { createClaudeSdkRunner } from '../runner.js'
import { createClaudeNativeSessionManager } from '../sessionManager.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../port.js'

export const scope = { deviceId: 'device-a', profilePath: '/profile-a', configRevision: 'revision-a', cwd: '/work' }

export const qualification = { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: true, history: true }

export const start = { kind: 'operator', correlationId: 'operator:one', configuration: {}, workingDirectory: '/work' } as NativeSessionStart

export function fixture(decodeFactory?: Parameters<typeof createClaudeNativeSessionManager>[0]['decodeFactory'], extra: Partial<Pick<Parameters<typeof createClaudeNativeSessionManager>[0], 'liveCallbacks' | 'interactionPort' | 'qualification' | 'pendingInteractions' | 'inspectionStart' | 'expectedMcp' | 'credentialEnvironmentVariables' | 'appMcpAccess' | 'sdkOptions' | 'initializationTimeoutMs' | 'scope'>> = {}, nativeVersion = '2.1.284') {
  const frames = new ClaudeBoundedQueue<unknown>(32)
  let messages: AsyncIterator<ClaudeSdkUserMessage>
  let ready!: () => void
  const started = new Promise<void>((resolve) => { ready = resolve })
  const close: Mock = vi.fn(() => frames.close())
  const statusRows = async () => [{ name: 'graphql', status: 'connected', source: 'dynamic', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app', headers: { Authorization: 'secret-token' } }, tools: [{ name: 'interaction_get' }] }]
  const statuses: Mock<typeof statusRows> = vi.fn(statusRows)
  const queries: Mock = vi.fn()
  const interrupt: Mock = vi.fn(async () => ({ still_queued: [] }))
  const setServers: Mock = vi.fn(async (servers: Readonly<Record<string, unknown>>) => { void servers; return { added: ['graphql'], removed: [], errors: {} } })
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284', query: (input) => {
      queries(input)
      messages = input.prompt[Symbol.asyncIterator](); ready()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt, initializationResult: async () => ({ models: [], account: {} }), mcpServerStatus: statuses, setMcpServers: setServers, close }
    }, getSessionInfo: async (sessionId) => ({ sessionId }), getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'fork' }),
  }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const offers: Mock = vi.fn()
  const open = runner.open
  runner.open = async (input) => {
    const session = await open(input)
    const offer = session.offer
    session.offer = (message, signal) => { offers(message); return offer(message, signal) }
    return session
  }
  const manager = createClaudeNativeSessionManager({ runner, scope, sdkOptions: {}, qualification, ...extra, ...(decodeFactory ? { decodeFactory } : {}) })
  return { frames, close, interrupt, manager, runner, client, statuses, queries, setServers, offers, nextMessage: async () => {
    await started
    const value = (await messages.next()).value
    if (value) void frames.offer({ type: 'system', subtype: 'init', session_id: 'native-session', claude_code_version: nativeVersion, cwd: '/work' })
    return value!
  } }
}

export function workflowRequest(): HarnessExecutionRequest {
  return { executionId: 'execution', runId: 'run', workspaceId: 'workspace',
    workflowNodeId: 'node', workingDirectory: '/work', runtimeDirectory: '/runtime',
    configuration: { id: 'config', workspaceId: 'workspace', agentId: 'agent', version: 1,
      prompt: {}, assignedSkills: [], contentHash: 'recorded', createdAt: '2026-10-06T00:00:00.000Z',
      harness: { harness: 'claude', model: 'recorded-model', authMode: 'subscription', configDirectory: '/profile-a',
        permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [],
        instructions: '', mcpServers: {} } }, initialPrompt: 'workflow notice',
    executionContext: { parentRequest: null }, input: { first: 'one', second: 'two' } }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function drain<T>(input: AsyncIterable<T>) { const values: T[] = []; for await (const value of input) values.push(value); return values }
