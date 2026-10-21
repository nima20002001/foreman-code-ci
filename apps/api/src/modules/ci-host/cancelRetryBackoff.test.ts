import { randomUUID } from 'node:crypto'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_RUN_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { ticketStore } from './ciTicketStore.testSupport.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

it('asks an executor that has not confirmed a superseded cancellation with growing gaps, not on every dispatch pass', async () => {
  const hostRef = { kind: 'cloud', mainId: 'main', provider: 'circleci', slot: 0 } as const
  const computer: HostCiComputer = { key: 'executor', label: 'Executor', priority: 0, hostRef }
  const now = new Date().toISOString()
  const run = CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: 'workspace', groupId: randomUUID(), suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'fixture/project', commit: 'a'.repeat(40),
    state: 'running', computer: { hostRef, label: computer.label }, step: 'lint', exitCode: null, message: null,
    queuedAt: now, startedAt: now, finishedAt: null, supersededBy: randomUUID(),
    initiator: { principalId: 'operator', executionId: null },
  })
  const store = ticketStore([run], { [run.id]: computer.key })
  const caller: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    grants: [{ actions: CI_RUN_ACTIONS, scope: { workspaceIds: [run.workspaceId] } }],
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  const authority: CiAuthority = { resolve: async () => ({ principal: caller, workspaceId: run.workspaceId }) }
  const cancel = vi.fn(async (runId: string) => ({ operation: 'cancel' as const, run: { runId, state: 'running' as const,
    step: 'lint', exitCode: null, startedAt: now, finishedAt: null, message: null, logBytes: 0 } }))
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async (_computer, input) => {
    if (input.operation === 'status') return { operation: 'status', ready: true, reasons: [],
      cpuCount: 1, memoryBytes: 1, slotsTotal: 1, slotsUsed: 1, runs: [] }
    if (input.operation === 'cancel') return cancel(input.runId)
    throw new DomainError('CI_COMPUTER_OFFLINE', 'Observation failed.', 503)
  } }
  const ci = new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool), authority,
    {} as CiCommits, endpoint)
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      await ci.dispatch()
      await ci.drain()
    }
    expect(cancel.mock.calls.length).toBeGreaterThan(0)
    expect(cancel.mock.calls.length).toBeLessThanOrEqual(2)
    expect(store.read(run.id).record.state).toBe('running')
  } finally {
    await ci.close()
  }
})
