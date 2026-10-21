import { randomUUID } from 'node:crypto'
import { CiGetOutputSchema, CiRunRecordSchema, type CiHostRun } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostCiService, HostCiComputer, HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { ciExecutionRunId } from '../src/modules/ci-host/executionAttempt.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

afterEach(() => vi.useRealTimers())

it('runs every cloud split independently and retains an abandoned executor on only the original ticket', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const original: HostCiComputer = { key: 'fixture:builder', label: 'Build executor', priority: 60,
    hostRef: { kind: 'device', mainId: 'fixture', deviceId: 'builder' } }
  const clouds: HostCiComputer[] = [0, 1].map(slot => ({ key: `fixture:cloud:github:${slot}`,
    label: `Cloud executor ${slot}`, priority: 30,
    hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'github', slot } }))
  const files = Array.from({ length: 4 }, (_, index) => `apps/api/test/selection-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 120_000]))
  const executions = new Map<string, { computer: string; files: string[]; run: CiHostRun }>()
  let cloudReady = false
  let finished = false
  const endpoint: HostCiEndpoint = { computers: async () => [original, ...clouds], request: async (computer, request) => {
    if (computer.key === original.key) throw new DeviceApplicationError('transport')
    if (request.operation === 'status') {
      const running = [...executions.values()].filter(entry => entry.computer === computer.key && !finished)
      return { operation: 'status', ready: cloudReady, reasons: [], cpuCount: 4, memoryBytes: 8 * 2 ** 30,
        slotsTotal: 1, slotsUsed: running.length, runs: running.map(entry => entry.run) }
    }
    if (request.operation === 'start') {
      // The host protocol treats repeated execution IDs as retries, regardless of the ticket's file selection.
      const existing = executions.get(request.runId)
      if (existing) return { operation: 'start', run: existing.run }
      const run: CiHostRun = { runId: request.runId, state: 'running', step: 'integration', exitCode: null,
        startedAt: new Date().toISOString(), finishedAt: null, message: null, logBytes: 0 }
      executions.set(request.runId, { computer: computer.key, files: request.files ?? [], run })
      return { operation: 'start', run }
    }
    if (request.operation !== 'read') throw new Error(`Unexpected ${request.operation}`)
    const entry = executions.get(request.runId)
    if (!entry) throw new Error('The executor has no such execution')
    const run = finished ? { ...entry.run, state: 'passed' as const, exitCode: 0,
      finishedAt: new Date().toISOString() } : entry.run
    return { operation: 'read', run, text: '', nextOffset: 0,
      ...(request.testResults && finished ? { testResults: {
        summary: { passed: entry.files.length, failed: 0, skipped: 0 }, truncated: false,
        files: entry.files.map(file => ({ file, status: 'passed' as const, durationMs: 120_000,
          tests: [{ name: `executes ${file}`, status: 'passed' as const, durationMs: 120_000 }] })),
      } } : {}) }
  } }
  const f = await fixture({ cloud: true, repositoryRunner: { endpoint, commits: {
    resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
  } } })
  const settle = async (ci: HostCiService = f.ci) => { await ci.dispatch(); await ci.drain() }
  const at = new Date().toISOString()
  const record = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: f.workspaceId,
    suite: 'integration', scope: 'full', gate: true, part: null, partition: null, files,
    repository: 'octo/site', ciMirror: 'octo/site-ci', commit: 'a'.repeat(40), state: 'running', step: 'integration',
    computer: { hostRef: original.hostRef, label: original.label }, plannedHostKey: original.key,
    integrationShards: 4, expectedDurationMs: 189_000, exitCode: null, message: null,
    queuedAt: at, startedAt: at, finishedAt: null, initiator: { principalId: 'operator', executionId: null } })
  try {
    await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record,durations)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [record.id, f.workspaceId, record.groupId, record.state, original.key, JSON.stringify(record), JSON.stringify(durations)])
    await settle()
    vi.setSystemTime(Date.now() + 438_000)
    await settle()
    const requeued = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: record.id })).run
    expect(requeued).toMatchObject({ state: 'queued', computer: null,
      retainedExecutions: [{ runId: record.id, executor: 'retained' }] })
    expect(ciExecutionRunId(requeued)).not.toBe(record.id)
    cloudReady = true
    vi.setSystemTime(Date.now() + 60_000)
    await settle()
    await settle()
    const split = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: record.id }))
    const children = split.partitions!
    expect(children).toHaveLength(2)
    expect(children.flatMap(child => child.files).sort()).toEqual([...files].sort())
    expect({ executions: new Set(children.map(ciExecutionRunId)).size,
      retainedOwners: children.flatMap(child => child.retainedExecutions ?? []).length })
      .toEqual({ executions: children.length, retainedOwners: 1 })
    expect(children.find(child => child.id === record.id)!.retainedExecutions)
      .toMatchObject([{ runId: record.id, hostKey: original.key, executor: 'retained' }])
    expect(executions.size).toBe(children.length)
    expect([...executions.values()].flatMap(entry => entry.files).sort()).toEqual([...files].sort())
    const denied = await f.connect(['workspaces:read'])
    expect((await f.call(denied, 'ci_get', { ticketId: record.id })).isError).toBe(true)
    finished = true
    await settle()
    for (const child of children) {
      const result = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
        ticketId: child.id, testStatus: ['passed'],
      }))
      expect(result).toMatchObject({ run: { state: 'passed', collection: 'complete' } })
      expect(result.tests!.files.map(file => file.file).sort()).toEqual([...child.files].sort())
      const stored = (await f.pool.query('select record from ci_runs where id=$1', [child.id])).rows[0]!.record
      expect(stored).toEqual(result.run)
    }
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: record.id })).group!.state)
      .toBe('passed')
  } finally { await f.close() }
})
