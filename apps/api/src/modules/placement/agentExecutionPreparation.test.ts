import { beforeEach, expect, it, vi } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import type { AcceptedNodePlacement, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import type { RunOwnership } from '../runs/ownership.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from './persistence.js'
import { AgentExecutionPreparation } from './agentExecutionPreparation.js'

vi.mock('../access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: vi.fn() }))
vi.mock('./persistence.js', () => ({
  readAcceptedPlacement: vi.fn(), readDispatchIntent: vi.fn(), readNativePlacement: vi.fn(),
  insertNativePlacement: vi.fn(),
}))
beforeEach(() => vi.resetAllMocks())

function fixture(host: 'main' | 'device', bound = true) {
  const execution = {
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1, state: 'running',
    createdAt: '2026-10-04T00:00:00Z', input: {},
    ...(bound ? { nativeSessionId: 'original-native-session' } : {}),
  } satisfies HarnessExecution
  const run = { id: 'run', workspaceId: 'workspace', workflowId: 'workflow',
    workflowVersionId: 'version', authorizationPrincipalId: 'principal' } as AcceptedWorkflowRunV3
  const placement = {
    hostRef: { kind: host }, payload: { kind: 'agent', agentConfigurationVersionId: 'configuration' },
    source: { kind: 'pending', rootId: 'root', bindingRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime' },
  } as AcceptedNodePlacement
  const native = { materialization: { operationId: 'original-operation' },
    workingTree: { canonicalCwd: '/materialized/tree' } } as NativeExecutionPlacement
  vi.mocked(readAcceptedPlacement).mockResolvedValue(placement)
  vi.mocked(readDispatchIntent).mockResolvedValue({ executionId: execution.id } as Awaited<ReturnType<typeof readDispatchIntent>>)
  vi.mocked(readNativePlacement).mockResolvedValue(native)
  vi.mocked(readLiveManagementPrincipal).mockResolvedValue({ id: 'principal' } as Awaited<ReturnType<typeof readLiveManagementPrincipal>>)
  const state = { sessionVerified: bound, profileChanged: false }
  const owner = {
    assertOwned: vi.fn(),
    runId: run.id,
    readOneShotFence: vi.fn(async () => ({ ownerId: 'owner', fence: '1' })),
    oneShotConnection: () => ({
      transaction: async (work: (sql: object) => Promise<unknown>) => work({
        query: async () => ({ rows: state.sessionVerified ? [{}] : [], rowCount: state.sessionVerified ? 1 : 0 }),
      }),
    }),
  } as unknown as RunOwnership
  const verifyWorkingDirectory = vi.fn(async () => native.workingTree)
  const sources = { verifyWorkingDirectory, resolveRootBinding: vi.fn(async () => ({})) } as unknown as SourceAdmissionPort
  const producer = {
    assertPinsCurrent: vi.fn(async (...args: Parameters<AgentPlacementProducer['assertPinsCurrent']>) => {
      if (state.profileChanged && args[4]?.purpose !== 'resident') {
        throw new Error('Saved profile changed before native entry')
      }
    }),
  } as unknown as AgentPlacementProducer
  const prepare = new AgentExecutionPreparation(sources as ConstructorParameters<typeof AgentExecutionPreparation>[0], producer)
  return { prepare, owner, run, execution, producer, verifyWorkingDirectory, state }
}

it('can read a bound remote result after the original source process closes and still checks current permission', async () => {
  const f = fixture('device')
  f.verifyWorkingDirectory.mockRejectedValue(new Error('original process closed'))
  const prepared = await f.prepare.prepare(f.owner, f.run, f.execution)
  expect(prepared?.workingDirectory).toBe('/materialized/tree')
  await prepared!.revalidate()
  expect(f.verifyWorkingDirectory).not.toHaveBeenCalled()
  vi.mocked(f.producer.assertPinsCurrent).mockRejectedValue(new Error('permission revoked'))
  await expect(prepared!.revalidate()).rejects.toThrow('permission revoked')
})

it.each(['main', 'device'] as const)('still verifies the source before first native entry on %s', async host => {
  const f = fixture(host, false)
  f.verifyWorkingDirectory.mockRejectedValue(new Error('source directory replaced'))
  await expect(f.prepare.prepare(f.owner, f.run, f.execution)).rejects.toThrow('source directory replaced')
})

it('keeps local source verification on continued native observation', async () => {
  const f = fixture('main')
  const prepared = await f.prepare.prepare(f.owner, f.run, f.execution)
  f.verifyWorkingDirectory.mockRejectedValue(new Error('source directory replaced'))
  await expect(prepared!.revalidate()).rejects.toThrow('source directory replaced')
})

it('continues an original verified remote session after the saved preset changes', async () => {
  const f = fixture('device')
  f.state.profileChanged = true
  const prepared = await f.prepare.prepare(f.owner, f.run, f.execution)
  await expect(prepared!.revalidate()).resolves.toBeUndefined()
})

it('does not treat a caller session ID as a verified original session', async () => {
  const f = fixture('device')
  f.state.sessionVerified = false
  f.state.profileChanged = true
  await expect(f.prepare.prepare(f.owner, f.run, f.execution)).rejects.toThrow('Saved profile changed')
})

it('requires the current Run owner before continuing a verified original session', async () => {
  const f = fixture('device')
  vi.mocked(f.owner.readOneShotFence).mockRejectedValue(new Error('Run owner lost'))
  await expect(f.prepare.prepare(f.owner, f.run, f.execution)).rejects.toThrow('Run owner lost')
})

it('rechecks the original session established after initial preparation', async () => {
  const f = fixture('device', false)
  const prepared = await f.prepare.prepare(f.owner, f.run, f.execution)
  f.state.sessionVerified = true
  f.state.profileChanged = true
  await expect(prepared!.revalidate()).resolves.toBeUndefined()
})
