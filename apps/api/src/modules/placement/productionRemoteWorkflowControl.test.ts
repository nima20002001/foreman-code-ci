import { beforeEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { AgentConfigurationVersion, HarnessExecution } from '@foreman-code/contracts'
import type { RunOwnership } from '../runs/ownership.js'
import { ExecutionScopedNativeSessionManagerResolver, type NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { InteractionDeliveryClaim } from '../interactions/delivery.js'
import { withOriginalInteractionDeliveryClaim } from '../interactions/originalDeliveryClaim.js'
const ports = vi.hoisted(() => ({ factory: vi.fn(), admission: vi.fn(),
  hostKind: 'device' as 'main' | 'device',
  materialization: { state: 'prepared', sourceBindingHash: 'a'.repeat(64) },
  intent: { runId: 'run', nodeId: 'node', executionId: 'execution', operationId: 'operation', technicalAttempt: 1,
    owner: { grantId: 'grant', epoch: '1' } } }))
vi.mock('./persistence.js', () => ({ readDispatchIntent: async () => ports.intent, readAcceptedPlacement: async () => ({ hostRef: { kind: ports.hostKind } }), readNativePlacement: async () => ({ original: true }) }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: async () => ports.intent }))
vi.mock('./executionBinding.js', () => ({ readNativeExecutionBinding: () => ({
  workingTree: { canonicalCwd: '/original/source' }, materialization: ports.materialization,
}) }))
vi.mock('./workerCarrier.js', () => ({ remoteNativeManager: ports.factory }))
vi.mock('../runs/remote/ownerControlAdmission.js', () => ({ admitRemoteOwnerControl: ports.admission }))
import { createProductionRemoteWorkflow } from './productionRemoteWorkflow.js'
import type { RemoteNativeManagerOptions } from '../runs/remote/nativeManagerProxy.js'
beforeEach(() => {
  vi.clearAllMocks()
  ports.hostKind = 'device'
  ports.materialization = { state: 'prepared', sourceBindingHash: 'a'.repeat(64) }
  ports.intent.owner = { grantId: 'grant', epoch: '1' }
  ports.intent.operationId = 'operation'
})

it.each(['main', 'device'] as const)('keeps the %s placement across source lifecycle transitions', async hostKind => {
  ports.hostKind = hostKind
  const composition = createProductionRemoteWorkflow({
    pool: {} as pg.Pool,
    locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({} as ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>),
    producer: () => undefined,
    execution: async () => ({
      id: 'execution', runId: 'run', workflowNodeId: 'node', attempt: 1,
      workingDirectory: '/original/source',
    } as HarnessExecution),
  })
  await composition.prepare('execution')
  for (const state of ['running', 'uncertain', 'closed']) {
    ports.materialization = { ...ports.materialization, state }
    await expect(composition.prepare('execution')).resolves.toMatchObject({ executionPlacement: {
      materialization: { state, sourceBindingHash: 'a'.repeat(64) },
    } })
  }
  ports.materialization = { ...ports.materialization, sourceBindingHash: 'b'.repeat(64) }
  await expect(composition.prepare('execution')).rejects.toMatchObject({ code: 'PLACEMENT_BINDING_CONFLICT' })
})

it('accepts a persisted owner renewal while retaining the original execution placement', async () => {
  const composition = createProductionRemoteWorkflow({
    pool: {} as pg.Pool,
    locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({} as ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>),
    producer: () => undefined,
    execution: async () => ({
      id: 'execution', runId: 'run', workflowNodeId: 'node', attempt: 1,
      workingDirectory: '/original/source',
    } as HarnessExecution),
  })
  await composition.prepare('execution')
  ports.intent = { ...ports.intent, owner: { grantId: 'renewed-grant', epoch: '2' } }
  await expect(composition.prepare('execution')).resolves.toMatchObject({ intent: { owner: ports.intent.owner } })
  ports.intent = { ...ports.intent, operationId: 'another-operation' }
  await expect(composition.prepare('execution')).rejects.toMatchObject({ code: 'PLACEMENT_BINDING_CONFLICT' })
})
async function fixture() {
  // Only common callback wiring is exercised. SQL metadata and admission are explicit port doubles.
  const events: string[] = [], sql = { original: true }
  const owner = { runId: 'run', assertOwned() {}, oneShotConnection: () => ({ transaction: async (work: (sql: unknown) => Promise<unknown>) => {
    events.push('begin')
    try { const result = await work(sql); events.push('commit'); return result } catch (error) { events.push('rollback'); throw error }
  } }) } as unknown as RunOwnership
  const composition = createProductionRemoteWorkflow({ pool: {} as pg.Pool, locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({} as ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>), producer: () => undefined,
    execution: async () => ({ id: 'execution', runId: 'run', workflowNodeId: 'node', attempt: 1, workingDirectory: '/original/source' } as HarnessExecution) })
  await composition.prepare('execution')
  composition.manager({ executionId: 'execution' } as NativeManagerResolutionContext, () => owner)
  const callbacks = ports.factory.mock.calls[0]![2] as Pick<RemoteNativeManagerOptions, 'controlFor'>
  return { events, sql, owner, callbacks }
}
it('passes the original attempt/token/fence into admission and commits before carrier dispatch', async () => {
  const f = await fixture(), claim = { interaction: { id: 'interaction', revision: 7 }, attempt: 2, ownerToken: 'original-private-token', correlationId: 'original-correlation',
    deliveryFence: '4', approvalConnectionGeneration: '2', mode: 'submit' } as InteractionDeliveryClaim
  const command = { kind: 'respond' as const, native: { sessionId: 'session', processIdentityDigest: 'a'.repeat(64) }, nativeRequestId: 'native-request', option: {} }
  ports.admission.mockImplementation(async () => { f.events.push('admit'); return { commandId: 'original-command' } })
  await withOriginalInteractionDeliveryClaim(claim, async () => {
    await f.callbacks.controlFor(command)
    f.events.push('native')
  })
  expect(ports.admission).toHaveBeenCalledExactlyOnceWith(f.sql, f.owner, expect.any(Object), command, claim)
  expect(f.events).toEqual(['begin', 'admit', 'commit', 'native'])
})
it('does not dispatch when the original command is already admitted and requires reconciliation', async () => {
  const f = await fixture()
  ports.admission.mockRejectedValue(new Error('REMOTE_CONTROL_ALREADY_ADMITTED'))
  const native = vi.fn()
  await expect(f.callbacks.controlFor({ kind: 'stop', native: { sessionId: 'session', processIdentityDigest: 'a'.repeat(64) } }).then(native)).rejects.toThrow('REMOTE_CONTROL_ALREADY_ADMITTED')
  expect(f.events).toEqual(['begin', 'rollback'])
  expect(native).not.toHaveBeenCalled()
})

it.each(['main', 'device'] as const)('keeps the %s placement when credential preflight resolves its manager', async hostKind => {
  ports.hostKind = hostKind
  const composition = createProductionRemoteWorkflow({
    pool: {} as pg.Pool,
    locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({} as ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>),
    producer: () => undefined,
    execution: async () => ({
      id: 'execution', runId: 'run', workflowNodeId: 'node', attempt: 1,
      workingDirectory: '/original/source',
    } as HarnessExecution),
  })
  const context: NativeManagerResolutionContext = {
    executionId: 'execution', runId: 'run', attempt: 1, agentId: 'agent',
    harness: 'codex', workingDirectory: '/original/source',
    configuration: { id: 'configuration' } as AgentConfigurationVersion,
  }
  const create = vi.fn(() => ({ harness: 'codex' } as NativeHarnessSessionManager))
  const managers = new ExecutionScopedNativeSessionManagerResolver(create)
  const allocated = managers.resolve(await composition.prepareContext(context))
  allocated.beginStart?.()

  expect(() => managers.resolve(context)).toThrow('cannot change native manager ownership context')
  const preflight = managers.resolve(await composition.prepareContext(context))
  expect(preflight.manager).toBe(allocated.manager)
  expect(preflight.lifecycle).toBe('starting')
  expect(create).toHaveBeenCalledOnce()
})
