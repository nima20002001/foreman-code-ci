import { CiRunRecordSchema, type CiHostReply, type CiHostRequest } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { ticketStore } from './ciTicketStore.testSupport.js'
import { HostCiService, type CiCommits, type HostCiComputer } from './service.js'

const github: HostCiComputer = { key: 'main:cloud:github:0', label: 'GitHub Actions', priority: 0,
  hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 } }
const builder: HostCiComputer = { key: 'main:builder', label: 'Builder', priority: 0,
  hostRef: { kind: 'main', mainId: 'main' } }
const runId = '00000000-0000-4000-8000-000000000001'
const startedAt = new Date(Date.now() - 5 * 60_000).toISOString()

/** A lint ticket running on GitHub whose workflow the provider only queued. */
const providerQueued = () => CiRunRecordSchema.parse({ id: runId, workspaceId: 'workspace', groupId: runId, suite: 'lint',
  part: null, scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
  ciMirror: 'owner/repo-ci', state: 'running', computer: { hostRef: github.hostRef, label: github.label }, step: 'queued',
  exitCode: null, message: null, queuedAt: startedAt, startedAt, finishedAt: null,
  initiator: { principalId: 'worker', executionId: null } })

function service(options: { computers: HostCiComputer[]; executorState: 'running' | 'queued' }) {
  const store = ticketStore([providerQueued()], { [runId]: github.key })
  const reads: Extract<CiHostRequest, { operation: 'read' }>[] = []
  const endpoint = { computers: async () => options.computers,
    request: async (_computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        return { operation: 'status', ready: true, reasons: [], cpuCount: 4, memoryBytes: 2 ** 33,
          slotsUsed: 0, slotsTotal: 1, runs: [] }
      }
      if (request.operation !== 'read') throw new Error(`Unexpected ${request.operation}`)
      reads.push(request)
      return { operation: 'read', run: { runId, state: options.executorState,
        step: options.executorState === 'running' ? 'queued' : null, exitCode: null, startedAt, finishedAt: null,
        logBytes: 0, message: null }, text: '', nextOffset: 0 }
    } }
  const authority: CiAuthority = { resolve: async principal => ({ principal, workspaceId: 'workspace' }) }
  const ci = new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool), authority, {} as CiCommits, endpoint)
  const pass = async () => { await ci.dispatch(); await ci.drain() }
  return { ci, store, reads, pass }
}

it('asks the cloud executor to move a provider-queued workflow only once another computer has a free slot', async () => {
  const f = service({ computers: [github, builder], executorState: 'running' })
  try {
    await f.pass()
    for (let pass = 0; pass < 2; pass++) await f.pass()
    expect(f.reads[0]).not.toHaveProperty('reassign')
    expect(f.reads.at(-1)).toMatchObject({ reassign: true })
  } finally {
    await f.ci.close()
  }
})

it('keeps the workflow in the provider queue while no other computer has room', async () => {
  const f = service({ computers: [github], executorState: 'running' })
  try {
    for (let pass = 0; pass < 3; pass++) await f.pass()
    expect(f.reads.length).toBeGreaterThan(0)
    for (const read of f.reads) expect(read).not.toHaveProperty('reassign')
  } finally {
    await f.ci.close()
  }
})

it('does not rule the provider out after moving a ticket its queue held without starting', async () => {
  const f = service({ computers: [github, builder], executorState: 'queued' })
  try {
    await f.pass()
    const record = f.store.read(runId).record
    expect(record.unstartedProviders).toBeUndefined()
    expect(record.message ?? '').not.toContain('dispatch retries exhausted')
  } finally {
    await f.ci.close()
  }
})
