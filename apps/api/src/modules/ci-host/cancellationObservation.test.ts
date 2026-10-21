import { randomUUID } from 'node:crypto'
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_RUN_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { ticketStore } from './ciTicketStore.testSupport.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

function fixture(kind: 'device' | 'cloud', options: { superseded?: boolean; state?: 'starting' | 'running' } = {}) {
  const hostRef = kind === 'device'
    ? { kind, mainId: 'main', deviceId: 'device' } as const
    : { kind, mainId: 'main', provider: 'github', slot: 0 } as const
  const computer: HostCiComputer = { key: 'executor', label: 'Executor', priority: 0, hostRef }
  const run = CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: 'workspace', groupId: randomUUID(), suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'fixture/project', commit: 'a'.repeat(40),
    state: options.state ?? 'running', computer: { hostRef, label: computer.label }, step: 'lint', exitCode: null, message: null,
    queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null,
    initiator: { principalId: 'operator', executionId: null },
    ...(options.superseded ? { supersededBy: randomUUID() } : {}),
  })
  const queued = CiRunRecordSchema.parse({ ...run, id: randomUUID(), state: 'queued', computer: null,
    startedAt: null, step: null })
  const store = ticketStore(options.superseded ? [run, queued] : [run], { [run.id]: computer.key })
  const caller: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    grants: [{ actions: CI_RUN_ACTIONS, scope: { workspaceIds: [run.workspaceId] } }],
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  const authority: CiAuthority = { resolve: async () => ({ principal: caller, workspaceId: run.workspaceId }) }
  const observationStarted = deferred()
  const observationReply = deferred()
  const cancellationStarted = deferred()
  const cancellationReply = deferred()
  const cancel = vi.fn(async (runId: string) => {
    cancellationStarted.resolve()
    await cancellationReply.promise
    return { operation: 'cancel' as const, run: { runId, state: 'canceled' as const,
      step: null, exitCode: null, startedAt: run.startedAt ?? new Date().toISOString(), finishedAt: new Date().toISOString(),
      message: 'Canceled.', logBytes: 0 } }
  })
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async (_computer, input) => {
    if (input.operation === 'status') return { operation: 'status', ready: true, reasons: [],
      cpuCount: 1, memoryBytes: 1, slotsTotal: 1, slotsUsed: 1, runs: [] }
    if (input.operation === 'cancel') return cancel(input.runId)
    if (input.operation !== 'read') throw new Error(`Unexpected ${input.operation}`)
    observationStarted.resolve()
    await observationReply.promise
    throw new DomainError('CI_COMPUTER_OFFLINE', 'Observation failed.', 503)
  } }
  const ci = new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool), authority,
    {} as CiCommits, endpoint)
  return { ci, caller, run, queued, store, cancel, observationStarted, observationReply,
    cancellationStarted, cancellationReply }
}

it.each(['device', 'cloud'] as const)(
  'settles a %s cancellation after an in-flight observation changes the ticket', async kind => {
    const f = fixture(kind)
    let cancellation: ReturnType<HostCiService['cancel']> | undefined
    try {
      await f.ci.dispatch()
      await f.observationStarted.promise
      cancellation = f.ci.cancel(f.caller, { workspaceId: f.run.workspaceId, ticketId: f.run.id })
      await f.cancellationStarted.promise
      f.observationReply.resolve()
      await f.ci.drain()
      expect(f.store.read(f.run.id).record).toMatchObject({ state: 'running',
        observation: { status: 'unavailable', consecutiveFailures: 1 } })
      f.cancellationReply.resolve()
      await expect(cancellation).resolves.toMatchObject({ run: { state: 'canceled',
        observation: { status: 'unavailable', consecutiveFailures: 1 } } })
      expect((await cancellation).run).not.toHaveProperty('cancellation')
      expect(f.store.read(f.run.id)).toMatchObject({ state: 'canceled', hostKey: null,
        record: { state: 'canceled', finishedAt: expect.any(String) } })
      await expect(f.ci.cancel(f.caller, { workspaceId: f.run.workspaceId, ticketId: f.run.id }))
        .resolves.toMatchObject({ run: { state: 'canceled' } })
      expect(f.cancel).toHaveBeenCalledTimes(1)
    } finally {
      f.observationReply.resolve()
      f.cancellationReply.resolve()
      await Promise.allSettled([cancellation])
      await f.ci.close()
    }
  },
)


it.each(['starting', 'running'] as const)(
  'sends one cancellation when superseded %s cleanup overlaps observation and leaves queued parts unassigned', async state => {
    const f = fixture('device', { superseded: true, state })
    f.observationReply.resolve()
    try {
      await f.ci.dispatch()
      await f.cancellationStarted.promise
      // Let the concurrent observation reach the executor while cleanup is awaiting its reply.
      await nextEventLoopTurn()
      f.cancellationReply.resolve()
      await f.ci.drain()
      expect(f.cancel.mock.calls).toEqual([[f.run.id]])
      expect(f.store.read(f.run.id)).toMatchObject({ state: 'canceled', hostKey: null })
      expect(f.store.read(f.queued.id)).toMatchObject({ state: 'canceled', hostKey: null,
        record: { computer: null, supersededBy: f.run.supersededBy } })
    } finally {
      f.cancellationReply.resolve()
      f.observationReply.resolve()
      await f.ci.close()
    }
  },
)
