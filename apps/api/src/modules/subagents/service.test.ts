import type pg from 'pg'
import { RunSubagentSchema, subagentCapabilities } from '@foreman-code/contracts/subagents'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunSubagentService } from './service.js'
import { reconcileRunSubagents } from './projection.js'

vi.mock('./projection.js', () => ({ reconcileRunSubagents: vi.fn() }))

const scope = { workspaceId: 'workspace', runId: 'run' }
const principal = { id: 'principal' } as ManagementPrincipal

describe('background subagent recovery diagnostics', () => {
  it('reports a failed scheduled recovery, drains it safely, and permits a later retry', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('private native content'))
    const report = vi.fn()
    const service = new RunSubagentService({ connect } as unknown as pg.Pool, undefined, vi.fn(), report)
    service.scheduleRecovery(principal, scope)
    service.scheduleRecovery(principal, scope)
    await service.close()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledExactlyOnceWith({ ...scope, code: 'SUBAGENT_RECOVERY_FAILED' })
    service.scheduleRecovery(principal, scope)
    await service.close()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('does not leave an unhandled task when a diagnostic sink fails', async () => {
    const service = new RunSubagentService({ connect: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as pg.Pool,
      undefined, vi.fn(), () => { throw new Error('diagnostic sink unavailable') })
    service.scheduleRecovery(principal, scope)
    await expect(service.close()).resolves.toBeUndefined()
  })
})

describe('subagent list snapshots', () => {
  beforeEach(() => vi.mocked(reconcileRunSubagents).mockReset())

  const timestamp = '2026-10-03T01:00:00.000Z'
  const child = RunSubagentSchema.parse({
    schemaVersion: 1, id: 'child', revision: '4', ...scope,
    workflowId: 'workflow', workflowVersionId: 'version',
    parentNodeId: 'node', parentAgentId: 'agent', parentExecutionId: 'execution', parentAttemptKey: 'execution:1',
    parentSubagentId: null, provider: 'codex', nativeMode: 'codex-multi-agent-v2',
    native: { parentSessionId: 'parent', childSessionId: 'native-child' },
    profile: { deviceId: 'device', harnessInstanceId: 'harness', providerVersion: '0.154.0' },
    name: 'Research', status: 'running', evidence: 'confirmed',
    firstObservedAt: timestamp, startedAt: timestamp, finishedAt: null, lastObservedAt: timestamp,
    coverage: { transcript: 'partial', tools: 'partial', gaps: true },
    capabilities: subagentCapabilities('codex-multi-agent-v2'),
  })

  function database(acquired: boolean, grants = [{ actions: ['runs:read'], scope: {} }]) {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ workflow_id: 'workflow', workflow_version_id: 'version', stopped: false }] })
      .mockResolvedValueOnce({ rows: [{ id: principal.id, name: 'Reader', audience: 'operator', grants,
        expires_at: new Date(Date.now() + 60_000), revoked_at: null, delegated_from: null }] })
      .mockResolvedValueOnce({ rows: [{ acquired }] })
      .mockResolvedValueOnce({ rows: [{ id: child.id, record: child }] })
      .mockResolvedValue({ rows: [] })
    const release = vi.fn()
    return { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as pg.Pool
  }

  it('returns a committed page marked catching-up while another request projects the Run', async () => {
    const service = new RunSubagentService(database(false))
    await expect(service.list(principal, scope)).resolves.toMatchObject({
      items: [{ subagent: child, availableActions: { sendInput: false, interrupt: false } }],
      nextCursor: null, projection: 'catching-up',
    })
    expect(reconcileRunSubagents).not.toHaveBeenCalled()
  })

  it('projects pending activity when the projection lock is available', async () => {
    vi.mocked(reconcileRunSubagents).mockResolvedValue('caught-up')
    const service = new RunSubagentService(database(true))
    await expect(service.list(principal, scope)).resolves.toMatchObject({
      items: [{ subagent: child, availableActions: { sendInput: false, interrupt: false } }],
      nextCursor: null, projection: 'caught-up',
    })
    expect(reconcileRunSubagents).toHaveBeenCalledOnce()
  })

  it('denies a reader without a live Run grant even when projection is busy', async () => {
    const service = new RunSubagentService(database(false, []))
    await expect(service.list(principal, scope)).rejects.toMatchObject({ status: 403 })
    expect(reconcileRunSubagents).not.toHaveBeenCalled()
  })
})
