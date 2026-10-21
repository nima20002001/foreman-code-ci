import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  type CodexHarnessConfiguration,
  type NativeSessionReference,
  type PendingNativeInteraction,
} from '@foreman-code/contracts'
import { afterEach, beforeEach, vi } from 'vitest'
import type { CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import type { NativeResponseAvailabilityQuery } from '../src/modules/harnesses/responseAvailability.js'
import type { WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { isObject } from '../src/modules/harnesses/codexStdioTransport.js'
import {
  calls,
  collect,
  emit,
  errorCode,
  fixture,
  fixtureQualification,
  input,
  processesForRequests,
  state,
  until,
  type Fixture,
} from './fixtures/codex-test-helpers.js'
import { writeNativeAcceptanceEvidence } from './helpers/nativeAcceptanceEvidence.js'
import {
  completeTestResourceCleanup,
  createTestRoot,
  registerTestResourceCleanup,
  removeTestRoot,
  type TestRoot,
} from '../../../scripts/test-resources.mjs'

// Only qualification is replaced here. Every lifecycle/translation/transport path
// below runs the repository implementation, including the pinned native schema gate.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})

let requestTimeoutMs = 10_000

vi.doMock('../src/modules/harnesses/codexStdioTransport.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexStdioTransport.js')>('../src/modules/harnesses/codexStdioTransport.js')
  class TestTransport extends actual.CodexStdioTransport {
    constructor(...args: ConstructorParameters<typeof actual.CodexStdioTransport>) {
      args[7] ??= requestTimeoutMs
      super(...args)
    }
  }
  return { ...actual, CodexStdioTransport: TestTransport }
})

export const { CodexAppServerSessionManager } = await import('../src/modules/harnesses/codexAppServer.js')

type Manager = InstanceType<typeof CodexAppServerSessionManager>

export const managers: Manager[] = []

export let f: Fixture

export let manager: Manager

export let source: WorkflowNativeSessionStart

let scratch: TestRoot

let scratchCleanupId: string

const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }

export function makeManager(
  overrides: Omit<Partial<Extract<CodexSessionDependencies, { mode: 'native' }>>, 'mode'> = {},
): Manager {
  const value = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'scoped', undefined, {
    mode: 'native', ...overrides,
  })
  managers.push(value)
  return value
}

export function codex(value = source): CodexHarnessConfiguration {
  const harness = value.request.configuration.harness
  assert.equal(harness.harness, 'codex')
  return harness as CodexHarnessConfiguration
}

export async function flag(name: string): Promise<void> { await writeFile(join(f.directory, name), '') }

export async function unflag(name: string): Promise<void> { await rm(join(f.directory, name), { force: true }) }

export async function json(name: string, value: unknown): Promise<void> { await writeFile(join(f.directory, name), JSON.stringify(value)) }

export async function wire(method?: string): Promise<JsonObject[]> {
  return (await calls(f.directory)).flatMap((entry) => isObject(entry.wire) && (!method || entry.wire.method === method) ? [entry.wire] : [])
}

export async function start(session: NativeSessionReference, prompt = 'wait', correlation = 'turn-correlation') {
  const result = collect(manager.startTurn(session, { prompt, clientCorrelationId: correlation }))
  await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.started' && event.payload.clientCorrelationId === correlation))
  return { result }
}

export async function pending(session: NativeSessionReference): Promise<PendingNativeInteraction> {
  return until(() => manager.pending(session))
}

export async function inject(session: NativeSessionReference, method: string, extra: JsonObject = {}, id = 4000): Promise<void> {
  const current = await state(f.directory, session.nativeSessionId)
  await emit(f.directory, { id, method, params: {
    threadId: session.nativeSessionId, turnId: current.turns.at(-1)!.id, startedAtMs: 1, ...extra,
  } })
}

export function responseQuery(value: PendingNativeInteraction): NativeResponseAvailabilityQuery {
  const { nativeRequestId, nativeTurnId } = value.turn
  assert(nativeRequestId && nativeTurnId)
  return { nativeRequestId, nativeRequestType: value.nativeRequestType, expectedNativeTurnId: nativeTurnId }
}

export async function respond(session: NativeSessionReference, value: PendingNativeInteraction, semantic = 'approve_once') {
  const option = value.responseOptions.find((entry) => entry.semantic === semantic)
  assert(option, `missing ${semantic}`)
  await manager.respond(session, value.turn.nativeRequestId!, option)
}

export async function assertCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => errorCode(error) === code, code)
}

export async function assertDead(pid: number): Promise<void> {
  await until(async () => { try { process.kill(pid, 0); return false } catch { return true } })
}

export async function assertSpawnedEnvironment(expected: Record<string, string | null>, launches: number): Promise<void> {
  const processes = await processesForRequests(f.directory, 'thread/start', 'thread/resume', 'thread/fork')
  assert.equal(processes.length, launches)
  assert.equal(new Set(processes.map((entry) => entry.pid)).size, launches)
  assert.deepEqual(processes.at(-1)!.environmentMatches,
    Object.fromEntries(Object.keys(expected).map((key) => [key, true])))
  for (const entry of await calls(f.directory)) {
    if (typeof entry.pid !== 'number') continue
    assert(isObject(entry.environmentMatches))
    for (const [key, value] of Object.entries(expected)) {
      if (value === null) assert.equal(entry.environmentMatches[key], true, key)
    }
  }
  await assertMetadataProcessesClosed()
}

export async function assertMetadataProcessesClosed(): Promise<void> {
  for (const entry of await processesForRequests(f.directory, 'model/list')) {
    assert(typeof entry.pid === 'number')
    await assertDead(entry.pid)
  }
}

export function useCodexFixture(options: { requestTimeoutMs?: number } = {}): void {
  beforeEach(async () => {
    requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    scratch = createTestRoot(tmpdir(), 'foreman-code-codex-wire-')
    scratchCleanupId = registerTestResourceCleanup(invocation, {
      kind: 'codex-wire-fixture', directory: scratch.directory, owner: scratch.token,
    })
    f = await fixture({ root: scratch })
    await flag('record-wire-timing')
    manager = makeManager()
    source = input(f.directory)
  })

  afterEach(async context => {
    const results = await Promise.allSettled(managers.splice(0).map((value) => value.shutdown()))
    if (context.task.result?.state === 'fail' || results.some(value => value.status === 'rejected')) {
      let timing = ''
      try { timing = await readFile(join(f.directory, 'wire-timing.jsonl'), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await writeNativeAcceptanceEvidence(`codex-fixture-${randomUUID()}.json`, {
        test: context.task.name, calls: await calls(f.directory),
        wireTiming: timing.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown),
      })
    }
    const failure = results.find((value) => value.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    removeTestRoot(scratch)
    completeTestResourceCleanup(invocation, scratchCleanupId)
  })
}

export function setManager(value: Manager): void {
  manager = value
}

export function setSource(value: WorkflowNativeSessionStart): void {
  source = value
}
