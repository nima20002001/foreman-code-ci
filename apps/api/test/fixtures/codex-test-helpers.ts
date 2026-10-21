import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type HarnessExecutionRequest, type NativeHarnessEvent } from '@foreman-code/contracts'
import type { WorkflowNativeSessionStart } from '../../src/modules/harnesses/port.js'
import { protocolFromBundle, type QualifiedCodex } from '../../src/modules/harnesses/codexProtocol.js'
import type { MessagePhase, Thread, ThreadItem } from '../../src/modules/harnesses/codexMethodTypes.js'
import { isObject, type JsonObject } from '../../src/modules/harnesses/codexStdioTransport.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { runCommand } from '../../src/modules/harnesses/process.js'
import { assertTestRoot, type TestRoot } from '../../../../scripts/test-resources.mjs'

export interface Fixture { directory: string; binary: string }
export async function fixture(options: { root?: TestRoot } = {}): Promise<Fixture> {
  if (options.root) assertTestRoot(options.root.directory, options.root.token)
  const directory = options.root?.directory ?? await mkdtemp(join(tmpdir(), 'graphql-codex-regression-'))
  const binary = join(directory, 'codex')
  const source = await readFile(new URL('./codex-app-server.cjs', import.meta.url), 'utf8')
  await writeFile(binary, `#!${process.execPath}\n${source}`)
  await chmod(binary, 0o755)
  return { directory, binary }
}
export function input(directory: string, agentId = 'agent-a'): WorkflowNativeSessionStart {
  const request: HarnessExecutionRequest = {
    executionId: `execution-${agentId}`, runId: 'run-1', workspaceId: 'workspace-1', workflowNodeId: 'node-1',
    workingDirectory: directory, runtimeDirectory: directory, input: {},
    configuration: {
      id: `configuration-${agentId}`, workspaceId: 'workspace-1', agentId, version: 1,
      prompt: { system: 'Test the native transport.' }, assignedSkills: [],
      harness: {
        harness: 'codex', model: 'test-model', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard',
        advanced: structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION),
      },
      contentHash: 'sha256:fixture', createdAt: '2026-09-16T00:00:00.000Z',
    },
  }
  return { request, environment: { agentId, variables: { TEST_AGENT_ID: agentId, GRAPHQL_MCP_TOKEN: `token-${agentId}` } } }
}
export async function calls(directory: string): Promise<JsonObject[]> {
  try { return (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonObject) }
  catch { return [] }
}
export async function processesForRequests(directory: string, ...methods: string[]): Promise<JsonObject[]> {
  const records = await calls(directory)
  const pids = new Set(records.flatMap(entry => isObject(entry.wire) && typeof entry.wire.method === 'string'
    && methods.includes(entry.wire.method) ? [entry.processPid] : []))
  return records.filter(entry => typeof entry.pid === 'number' && pids.has(entry.pid))
}
export async function emit(directory: string, value: unknown, agentId = 'agent-a'): Promise<void> {
  await appendFile(join(directory, `inbox-${agentId}.jsonl`), JSON.stringify(value) + '\n')
}
export async function state(directory: string, sessionId: string): Promise<{ id: string; turns: JsonObject[]; settings: JsonObject }> {
  return JSON.parse(await readFile(join(directory, `state-${sessionId}.json`), 'utf8')) as { id: string; turns: JsonObject[]; settings: JsonObject }
}
export async function finish(directory: string, sessionId: string, answer = 'correct-answer'): Promise<void> {
  const current = await state(directory, sessionId)
  const turn = current.turns.at(-1)!
  assert(Array.isArray(turn.items))
  await emit(directory, { method: 'turn/completed', params: { threadId: sessionId, turn: {
    ...turn, status: 'completed', completedAt: 2,
    items: [...turn.items, agentMessage(`answer:${turn.id}`, answer)],
  } } })
}
// Integration suites run many production fixtures at once; a fixture state change can lag well past 5 s.
export async function until<T>(
  probe: () => Promise<T | undefined | false>,
  timeout = 20_000,
  schedule = setTimeout,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    await new Promise((resolve) => schedule(resolve, 10))
  }
  throw new Error('Timed out waiting for fixture state.')
}
export function collect(iterator: AsyncIterable<NativeHarnessEvent>): Promise<NativeHarnessEvent[]> {
  const result = (async () => { const events: NativeHarnessEvent[] = []; for await (const event of iterator) events.push(event); return events })()
  void result.catch(() => {
    // ignore: The caller awaits the original promise, which retains the rejection.
  })
  return result
}
export function errorCode(error: unknown): string | undefined {
  return error instanceof HarnessExecutionError ? error.result.error?.code : undefined
}
// Unchanged upstream rust-v0.154.0 bundle at commit 6b9826e3aa83b1a5947db50f4332cb9c65f1b340:
// codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.schemas.json.
// Provider qualification remains a test seam; payload validation uses the production compiler.
export const fixtureProtocol = protocolFromBundle(JSON.parse(
  readFileSync(new URL('./codex-protocol.schemas.json', import.meta.url), 'utf8'),
) as JsonObject)

export function nativeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'native-thread-1', sessionId: 'native-thread-1', forkedFromId: null, parentThreadId: null,
    preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
    historyMode: 'legacy', modelProvider: 'openai', model: 'test-model', reasoningEffort: 'medium',
    createdAt: 1, updatedAt: 1, recencyAt: null, status: { type: 'idle' }, path: null,
    cwd: process.cwd(), cliVersion: '0.154.0', originator: null, source: 'appServer', threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [], ...overrides,
  }
}

export function agentMessage(
  id: string, text: string, phase: MessagePhase | null = 'final_answer',
): Extract<ThreadItem, { type: 'agentMessage' }> {
  return { type: 'agentMessage', id, text, phase, memoryCitation: null, delivery: null, questions: null }
}
export async function fixtureQualification(
  binary: string, cwd: string, environment: NodeJS.ProcessEnv,
  requireAuthentication: boolean, signal?: AbortSignal,
): Promise<QualifiedCodex> {
  const version = await runCommand(binary, ['--version'], cwd, signal, environment)
  const installed = version.stdout.trim()
  if (version.exitCode !== 0 || !/^codex-cli \d+\.\d+\.\d+$/.test(installed)) {
    throw new HarnessExecutionError('CODEX_APP_SERVER_VERSION_UNQUALIFIED', 'Fixture version rejected.')
  }
  if (requireAuthentication) {
    const auth = await runCommand(binary, ['login', 'status'], cwd, signal, environment)
    if (auth.exitCode !== 0) throw new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Fixture authentication rejected.')
  }
  return {
    binary, identity: 'test-double', providerVersion: installed, protocol: fixtureProtocol,
    schemaManifestSha256: 'test-double-not-installed-evidence', stableSchemaGitBlob: 'test-double', referenceSchemaManifestSha256: 'test-double',
  }
}
