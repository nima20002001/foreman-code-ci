import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { NativeProcessRegistry, spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { sessionAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import type { NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { RepeatNativeObservationStore } from '../src/modules/interactions/repeatObservation.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import type pg from 'pg'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await new NativeProcessRegistry(directory).closeOwner('execution:test')
    await rm(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'native-response-recovery-'))
  directories.push(path)
  return path
}
const evidence: NativeResponseDeliveryEvidence = {
  source: 'provider_acknowledgement', harness: 'codex', providerVersion: '0.154.0',
  nativeSessionId: 'session-test', nativeRequestId: 'request-test', nativeRequestType: 'permission.asked',
  optionId: 'once-test', semantic: 'approve_once',
}
const reference: NativeSessionReference = { harness: evidence.harness, providerVersion: evidence.providerVersion,
  nativeSessionId: evidence.nativeSessionId }
const response = { nativeRequestId: evidence.nativeRequestId, nativeRequestType: evidence.nativeRequestType,
  option: { optionId: evidence.optionId, semantic: evidence.semantic, label: 'Approve once', persistence: 'request' as const,
    affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false } }

describe('durable native response receipts', () => {
  it('recovers from a replacement manager/journal after caller persistence fails', async () => {
    const root = await directory()
    new NativeResponseJournal(root).record(evidence)
    expect(new NativeResponseJournal(root).read(reference, response)).toEqual(evidence)
  })
  it('does not turn missing or conflicting receipts into permission to resend', async () => {
    const journal = new NativeResponseJournal(await directory())
    expect(journal.read(reference, response)).toBeUndefined()
    journal.record(evidence)
    expect(() => journal.record({ ...evidence, semantic: 'reject', optionId: 'reject-test' })).toThrow(/Conflicting/)
    expect(journal.read(reference, response)).toEqual(evidence)
  })
  it('cannot use a receipt for another native session or selected option', async () => {
    const journal = new NativeResponseJournal(await directory())
    journal.record(evidence)
    expect(journal.read({ ...reference, nativeSessionId: 'other' }, response)).toBeUndefined()
    expect(() => journal.read(reference, { ...response, option: { ...response.option, optionId: 'other' } })).toThrow(/does not match/)
  })
})

it.skipIf(process.platform !== 'linux')('fresh registry closes the registered launch boundary without replay or PID-only signals', async (context) => {
  const root = await directory()
  const registry = new NativeProcessRegistry(root)
  const child = spawnNativeProcess(process.execPath, ['-e', "console.log('ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    cwd: root, env: {}, recovery: await registry.reserveLaunch('execution:test'),
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const ready = await new Promise<boolean>((resolve) => {
    const started = () => { child.removeListener('close', exited); resolve(true) }
    const exited = () => { child.stdout.removeListener('data', started); resolve(false) }
    child.stdout.once('data', started)
    child.once('close', exited)
  })
  if (!ready) {
    expect(stderr).toMatch(/Native launch refused: delegated cgroup v2/)
    expect(await registry.closeOwner('execution:test')).toBe(true)
    context.skip('This process test requires a writable delegated cgroup v2 with cgroup.kill.')
    return
  }
  expect(await new NativeProcessRegistry(root).closeOwner('execution:test')).toBe(true)
  expect(sessionAlive(child.pid!)).toBe(false)
  expect(await registry.closeOwner('execution:test')).toBe(true)
}, 10_000)

it('uncertain approval recovery cannot start native work without its exact admitted request', async () => {
  const fixture = NATIVE_INTERACTION_FIXTURES.codex
  const option = fixture.responseOptions[0]!
  const interaction = { ...fixture, selectedOptionId: option.optionId, selectedSemantic: option.semantic,
    nativeResponse: { optionId: option.optionId }, status: 'delivery_pending' as const,
    deliveryState: 'uncertain' as const, decidedAt: fixture.createdAt }
  const execution: HarnessExecution = {
    id: interaction.executionId, runId: interaction.runId, workflowNodeId: 'node-test', agentId: interaction.requestingAgentId,
    agentConfigurationVersionId: 'configuration-test', attempt: 1, input: {}, state: 'waiting',
    nativeSessionId: interaction.nativeSessionId, createdAt: interaction.createdAt,
  }
  const updateExecution = vi.fn(async () => undefined), resolve = vi.fn()
  const runs = { updateExecution } as unknown as PostgresRunRepository
  const coordinator = new ApprovalExecutionCoordinator(runs,
    new Wave25InteractionRepository({} as pg.Pool), {} as PostgresApprovalBudgetRepository,
    { resolve } as unknown as NativeSessionManagerResolver, 60_000)
  const owner = { runId: execution.runId, assertOwned() {}, client: {} } as unknown as RunOwnership
  const store = { readExecution: async () => ({ execution }) } as unknown as RepeatNativeObservationStore
  await expect(coordinator.observeExact({ execution, store, owner, workflowId: interaction.workflowId,
    graphThreadId: execution.runId, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'REPEAT_EXECUTION_INPUT_CONFLICT' })
  expect(updateExecution).not.toHaveBeenCalled()
  expect(resolve).not.toHaveBeenCalled()
  expect(interaction.deliveryState).toBe('uncertain')
  expect(execution.state).toBe('waiting')
})
