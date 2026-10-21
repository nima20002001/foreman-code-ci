import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type HarnessExecution,
  type NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { RuntimeShutdown } from '../src/infrastructure/runtimeShutdown.js'
import { deviceRequestTimeoutMs } from '../src/modules/devices/deviceRequestRetry.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import { rejectableDeferred } from './helpers/deferred.js'

vi.mock('../src/modules/interactions/retainedRemoteReviewer.js', () => {
  const retained = (_sql: unknown, execution: HarnessExecution) => ({
    generation: execution.id, principalId: `principal:${execution.id}`,
    session: { harness: 'codex', providerVersion: 'fixture', nativeSessionId: execution.nativeSessionId },
  })
  return {
    readRecoverableRemoteReviewer: async (sql: unknown, execution: HarnessExecution) => ({
      ...retained(sql, execution), detached: false,
    }),
    readRetainedRemoteReviewer: async (sql: unknown, execution: HarnessExecution) => retained(sql, execution),
    retainRemoteReviewerCredential: async () => {},
  }
})

function restartOwnershipFixture(options: {
  executionIds?: string[]
  renew?: () => Promise<string>
  observeBoundary?: NonNullable<NativeHarnessSessionManager['observeBoundary']>
} = {}) {
  const saved = makeCurrentWorkflowFixture('restart-ownership', 'approval')
  const createdAt = '2026-10-01T00:00:00.000Z'
  const configuration: AgentConfigurationVersion = {
    id: 'configuration', agentId: 'reviewer', workspaceId: 'workspace', version: 1,
    productRole: 'orchestrator', prompt: { system: 'Review assigned interactions' }, assignedSkills: [],
    harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'fixture', createdAt,
  }
  const executions: HarnessExecution[] = (options.executionIds ?? ['first', 'second']).map(id => ({
    id, runId: 'run', workflowNodeId: `node:${id}`, agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: {}, state: 'completed',
    nativeSessionId: `session:${id}`, workingDirectory: '/project', runtimeDirectory: `/runtime/${id}`,
    result: { outcome: 'succeeded' }, createdAt, finishedAt: createdAt,
  }))
  const sessions = new Map(executions.map(execution => [execution.id, {
    harness: 'codex', providerVersion: 'fixture', nativeSessionId: execution.nativeSessionId!,
  } satisfies NativeSessionReference]))
  const owners: RunOwnership[] = []
  let locked = false
  const acquireOwnership = vi.fn(async () => {
    if (locked) return undefined
    locked = true
    let owned = true
    let retained = 0
    let releaseRequested = false
    const finish = () => {
      if (releaseRequested && retained === 0) {
        owned = false
        locked = false
      }
    }
    const owner = {
      runId: 'run',
      assertOwned() {
        if (!owned) throw new DomainError('RUN_OWNERSHIP_LOST', 'The Run owner has released its lock.', 409)
      },
      oneShotConnection: () => ({ transaction: async (work: (sql: unknown) => Promise<unknown>) => work({}) }),
      retain() {
        owner.assertOwned()
        retained++
        return async () => {
          retained--
          finish()
        }
      },
      release: async () => {
        releaseRequested = true
        finish()
      },
    } as unknown as RunOwnership
    owners.push(owner)
    return owner
  })
  const closeOwners: RunOwnership[] = []
  const disposal = vi.fn(async () => {})
  const managers = new ExecutionScopedNativeSessionManagerResolver((context, getOwner) => ({
    harness: 'codex', retainsReviewerSession: true,
    attachSession: async () => sessions.get(context.executionId)!,
    originalApplicationAccess: async () => ({}),
    closeForRestart: async (session: NativeSessionReference) => {
      expect(session).toEqual(sessions.get(context.executionId))
      const owner = getOwner()!
      owner.assertOwned()
      closeOwners.push(owner)
    },
    observeBoundary: options.observeBoundary ?? (async () => {}),
    dispose: disposal,
  } as unknown as NativeHarnessSessionManager))
  const coordination = nativeLanes()
  vi.spyOn(coordination, 'workflowSession').mockImplementation(async id => ({
    session: sessions.get(id)!, finalized: true, reviewerActive: false,
  }))
  const detached = vi.fn(async (_execution: HarnessExecution, _session: NativeSessionReference,
    _generation: string, assertCurrent: () => void) => {
    expect(locked).toBe(true)
    assertCurrent()
  })
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const credentials = {
    recoverRemote: async (id: string) => ({ principalId: `principal:${id}`,
      environment: { agentId: configuration.agentId, variables: {} },
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    revokeForExecution: vi.fn(async () => {}),
    ...(options.renew ? { renew: options.renew } : {}),
  }
  const coordinator = new ApprovalExecutionCoordinator({
    acquireOwnership,
    getRepeatSnapshot: async (_runId: string, owner: RunOwnership) => {
      owner.assertOwned()
      expect(locked).toBe(true)
      return { stopRequested: false, cleanupPending: false,
        run: { ...saved.run, id: 'run', workspaceId: 'workspace', executionState: 'waiting' },
      }
    },
    getExecution: async (id: string) => executions.find(execution => execution.id === id),
    // The owner-scoped repeat store claims no queued workflow input for a completed execution.
    repeat: async (owner: RunOwnership) => {
      owner.assertOwned()
      expect(locked).toBe(true)
      return { claimWorkflowInput: async (id: string) => {
        expect(executions.find(execution => execution.id === id)?.state).toBe('completed')
        return undefined
      } }
    },
    getExecutionConfiguration: async () => configuration,
    getRepeatVersion: async () => ({ ...saved.version, definition: { ...saved.version.definition,
      nodes: executions.map(execution => ({ ...saved.version.definition.nodes[0]!, id: execution.workflowNodeId })),
    } }),
    get: async () => ({ id: 'run', workspaceId: 'workspace', executionState: 'waiting', outcome: 'pending',
      workflowVersionId: saved.version.id,
      approval: { handler: 'orchestrator', designatedOrchestratorAgentId: configuration.agentId } }),
  } as unknown as Args[0], { coordination } as unknown as Args[1], {} as Args[2], managers, 60_000,
  credentials as unknown as Args[5], undefined, { recordDetached: detached } as unknown as Args[7],
  undefined, undefined, undefined, undefined, undefined, async context => ({
    ...context, acceptedPlacement: { hostRef: { kind: 'device' } } as NonNullable<typeof context.acceptedPlacement>,
  }))
  return {
    coordinator, managers, executions, owners, acquireOwnership, closeOwners, detached, disposal, credentials,
    locked: () => locked,
    async attachReviewers() {
      for (const execution of executions) {
        await coordinator.attachOwnedSession({ harness: 'codex', executionId: execution.id,
          agentId: execution.agentId, workingDirectory: execution.workingDirectory!, purpose: 'reviewer' },
        sessions.get(execution.id)!)
        await coordinator.releaseReviewSession(execution.id)
        expect(locked).toBe(false)
      }
    },
  }
}

it('shares one reacquired Run owner across sibling retained session detachment', async () => {
  const f = restartOwnershipFixture()
  await f.attachReviewers()
  const acquisitions = f.acquireOwnership.mock.calls.length
  await f.coordinator.closeForRestart()
  expect(f.acquireOwnership.mock.calls.length).toBe(acquisitions + 1)
  expect(f.closeOwners).toEqual([f.owners.at(-1), f.owners.at(-1)])
  expect(f.detached).toHaveBeenCalledTimes(2)
  expect(f.locked()).toBe(false)
  await f.managers.dispose()
})

it('uses an adopted live Run owner when a previous shared owner has released', async () => {
  const f = restartOwnershipFixture()
  await f.attachReviewers()
  const previous = (await f.acquireOwnership())!
  const stopSharing = f.coordinator.shareRunOwner(previous)
  await previous.release()
  const current = (await f.acquireOwnership())!
  f.coordinator.adoptRunOwner(current)
  const acquisitions = f.acquireOwnership.mock.calls.length
  try {
    await f.coordinator.closeForRestart()
    expect(f.acquireOwnership.mock.calls.length).toBe(acquisitions)
    expect(f.closeOwners).toEqual([current, current])
    expect(f.detached).toHaveBeenCalledTimes(2)
  } finally {
    stopSharing()
    await current.release()
    await f.managers.dispose()
  }
})

it('does not report a Run owner that lost its lock as a reconciliation failure', async () => {
  const f = restartOwnershipFixture()
  await f.attachReviewers()
  const lost = (await f.acquireOwnership())!
  const stopSharing = f.coordinator.shareRunOwner(lost)
  f.coordinator.workflowChatOwner({} as never, (async () => {}) as never)
  await lost.release()
  const failures: unknown[] = []
  try {
    await f.coordinator.reconcileWorkflowControls(error => failures.push(error))
    expect(failures).toEqual([])
  } finally {
    stopSharing()
    await f.managers.dispose()
  }
})

it.each([
  { boundary: 'acquiring', timeout: false },
  { boundary: 'observing', timeout: false },
  { boundary: 'releasing', timeout: false },
  { boundary: 'acquiring', timeout: true },
] as const)(
  'drains reviewer renewal at $boundary before runtime release (drain times out=$timeout)', async ({ boundary, timeout }) => {
    vi.useFakeTimers()
    const entered = rejectableDeferred()
    const finished = rejectableDeferred()
    const releaseOwnership = vi.fn(async () => {})
    const f = restartOwnershipFixture({
      executionIds: ['reviewer'],
      renew: async () => new Date(Date.now() + 60_000).toISOString(),
      observeBoundary: async (_session, signal) => {
        if (boundary === 'observing') {
          entered.resolve()
          await finished.promise
        }
        signal?.throwIfAborted()
      },
    })
    const lifecycle = new RuntimeShutdown({
      stop: [{ name: 'workflow engine', run: () => f.coordinator.closeForRestart() }],
      drain: [],
      dispose: [{ name: 'execution native managers', run: async () => {
        await f.coordinator.closeForRestart()
        await f.managers.dispose()
      } }],
      releaseOwnership,
    })
    let closing: Promise<unknown> | undefined
    let settled = false
    try {
      await f.attachReviewers()
      const original = structuredClone(f.executions)
      const acquire = f.acquireOwnership.getMockImplementation()!
      f.acquireOwnership.mockImplementationOnce(async () => {
        const owner = await acquire()
        expect(owner).toBeDefined()
        if (boundary === 'acquiring') {
          entered.resolve()
          await finished.promise
        }
        if (boundary === 'releasing') {
          const release = owner!.release.bind(owner)
          vi.spyOn(owner!, 'release').mockImplementation(async () => {
            entered.resolve()
            await finished.promise
            await release()
          })
        }
        return owner
      })
      await vi.advanceTimersByTimeAsync(0)
      await entered.promise
      expect(f.locked()).toBe(true)
      const acquisitions = f.acquireOwnership.mock.calls.length
      closing = lifecycle.finish().then(() => {
        settled = true
      }, (error: unknown) => {
        settled = true
        return error
      })
      // The heartbeat stopper's bounded wait is shorter than the native operation.
      await vi.advanceTimersByTimeAsync(timeout ? 2 * deviceRequestTimeoutMs + 1 : 1_001)
      if (!timeout) expect(lifecycle.pending()).toEqual(['workflow engine'])
      if (timeout) {
        // Both production phases time out without abandoning the captured operation.
        expect(await closing).toBeInstanceOf(AggregateError)
      } else {
        expect(settled).toBe(false)
      }
      expect(f.acquireOwnership.mock.calls.length).toBe(acquisitions)
      expect(f.closeOwners).toEqual([])
      expect(f.detached).not.toHaveBeenCalled()
      expect(f.disposal).not.toHaveBeenCalled()
      expect(releaseOwnership).not.toHaveBeenCalled()
      finished.resolve()
      if (timeout) await lifecycle.finish()
      else expect(await closing).toBeUndefined()
      expect(f.closeOwners).toEqual([f.owners.at(-1)])
      expect(f.detached).toHaveBeenCalledTimes(1)
      expect(f.disposal).toHaveBeenCalledTimes(1)
      expect(f.locked()).toBe(false)
      expect(releaseOwnership).toHaveBeenCalledTimes(1)
      expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
      expect(f.executions).toEqual(original)
    } finally {
      finished.resolve()
      await closing
      try {
        await lifecycle.finish()
      } finally {
        vi.useRealTimers()
      }
    }
  },
)
