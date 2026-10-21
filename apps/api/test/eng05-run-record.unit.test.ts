import { Buffer } from 'node:buffer'
import type pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  AcceptedWorkflowRunV3Schema, CurrentOperatorToolNameSchema, RUN_INSPECTION_LIMITS, RUN_INSPECTION_TOOLS,
  RunRecordDetailSchema, RunRecordGetInputSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import {
  runInspectionRequirements, runInspectionToolAvailable, unavailableRunInspectionToolCall,
} from '../src/mcp/operator/tools/runInspection.js'
import { DomainError } from '../src/modules/errors.js'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { withCurrentRunRead } from '../src/modules/runs/currentRead.js'
import { RunInspectionService } from '../src/modules/runs/inspection.js'
import type { AcceptedRepeatRunSnapshot } from '../src/modules/runs/repeatStartRead.js'

// This unit boundary supplies a validated immutable snapshot, not execution
// history. Actual SQL identity, live grants, HTTP/MCP and denial audit are covered
// by these opt-in PostgreSQL integration fixtures:
// eng05-run-inspection-saved-resolution.integration.test.ts
// eng05-run-inspection-publication.integration.test.ts
// eng05-run-inspection-fork-join.integration.test.ts
// eng05-run-inspection-repeat.integration.test.ts
// eng05-run-inspection-waiting.integration.test.ts
// eng05-run-inspection-large-record.integration.test.ts
vi.mock('../src/modules/runs/currentRead.js', () => ({ withCurrentRunRead: vi.fn() }))
const f = makeCurrentWorkflowFixture('run-record-unit', 'single')
const input = { workspaceId: f.scope.workspaceId, runId: f.run.id }
const location = { runnerId: 'record-runner', rootPath: '/private/record-root', locationRevision: 7,
  identityHash: `sha256:${'a'.repeat(64)}` }
function principal(grants: ManagementPrincipal['grants']): ManagementPrincipal {
  return { id: 'record-reader', name: 'Record reader', audience: 'operator', grants,
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
}
const caller = principal([{ actions: ['runs:read', 'workspace_locations:read'], scope: {} }])
let live: ManagementPrincipal
let snapshot: AcceptedRepeatRunSnapshot
const query = vi.fn(() => { throw new Error('A Run-only read must not query history or activity') })
const sql = { query } as unknown as GraphTransactionSql
const pool = {} as pg.Pool
const service = new RunInspectionService(pool)
beforeEach(() => {
  vi.clearAllMocks()
  live = principal([{ actions: ['runs:read'], scope: { runIds: [f.run.id] } }])
  snapshot = { run: AcceptedWorkflowRunV3Schema.parse({ ...f.run,
    authorizationPrincipalId: 'private-run-owner', executionLocation: location,
    input: { instruction: 'exact original input', nested: [false, 0, null, { text: 'keep me' }] },
    executionState: 'completed', outcome: 'failed', finishedAt: f.createdAt,
    result: { outcome: 'failed', error: { code: 'EXACT_FAILURE', message: 'Original failure', retryable: true } },
  }), version: f.version, configurations: f.configurations, stopRequested: true, cleanupPending: true }
  const read: typeof withCurrentRunRead = async (_pool, _principal, _workspaceId, _runId, _action, work) => work(sql, snapshot, live)
  vi.mocked(withCurrentRunRead).mockImplementation(read)
})
afterEach(() => vi.restoreAllMocks())

describe('bounded private Run record service', () => {
  it('reads only the exact Run snapshot, pins and independent Stop/cleanup facts', async () => {
    const before = structuredClone(snapshot)
    const result = await service.record(caller, input)
    expect(withCurrentRunRead).toHaveBeenCalledTimes(1)
    expect(withCurrentRunRead).toHaveBeenCalledWith(pool, caller, input.workspaceId, input.runId, 'runs:read', expect.any(Function), expect.any(Function))
    expect(query).not.toHaveBeenCalled()
    expect(Object.keys(result).sort()).toEqual(['cleanupPending', 'run', 'stopRequested'])
    expect(result.run).toEqual(Object.fromEntries(Object.entries(before.run)
      .filter(([key]) => !['authorizationPrincipalId', 'executionLocation'].includes(key))))
    expect(result.run).not.toHaveProperty('authorizationPrincipalId')
    expect(result.run).not.toHaveProperty('executionLocation')
    expect(result.run).not.toHaveProperty('repeat')
    expect(result.stopRequested).toBe(true)
    expect(result.cleanupPending).toBe(true) // terminal is NOT cleanup settlement
    expect(snapshot).toEqual(before) // redaction never mutates the accepted record
    snapshot.cleanupPending = false
    expect(await service.record(caller, input)).toMatchObject({ stopRequested: true, cleanupPending: false })
  })

  it('uses live location grants rather than the transport principal, never disclosing the admission principal', async () => {
    const stale = await service.record(caller, input)
    expect(stale.run).not.toHaveProperty('executionLocation')
    live.grants.push({ actions: ['workspace_locations:read'], scope: { workspaceIds: ['other-workspace'] } })
    expect((await service.record(caller, input)).run).not.toHaveProperty('executionLocation')
    live.grants.push({ actions: ['workspace_locations:read'], scope: { workspaceIds: [input.workspaceId] } })
    // Conversely, a transport snapshot lacking the new grant must not over-redact
    // a location permitted by the live, transaction-locked principal.
    const result = await service.record(principal([{ actions: ['runs:read'], scope: {} }]), input)
    expect(result.run.executionLocation).toEqual(location)
    expect(result.run).not.toHaveProperty('authorizationPrincipalId')
    expect(query).not.toHaveBeenCalled()
  })

  it('retains an absent result on a nonterminal Run without inventing a result or execution rows', async () => {
    snapshot.run = AcceptedWorkflowRunV3Schema.parse({ ...f.run,
      authorizationPrincipalId: 'private-run-owner', executionLocation: location })
    snapshot.stopRequested = false; snapshot.cleanupPending = false
    const result = await service.record(caller, input)
    expect(result.run.executionState).toBe('queued')
    expect(result.run).not.toHaveProperty('result')
    expect(result).not.toHaveProperty('executions')
    expect(query).not.toHaveBeenCalled()
  })

  it.each([{ ...input, executions: true }, { ...input, cursor: 'history' }, { ...input, limit: 1 }, { runId: input.runId }])(
    'rejects extra/history or incomplete request arguments before opening a read', async (raw) => {
      await expect(service.record(caller, raw)).rejects.toBeInstanceOf(z.ZodError)
      expect(withCurrentRunRead).not.toHaveBeenCalled()
    })

  it('bounds UTF-8 bytes of the exact Run-only response without truncation or history reads', async () => {
    // Byte-bound fixture only, NOT an admitted Run/native input. Character count
    // alone is below the limit, but encoded bytes are above the response limit.
    const text = '🙂'.repeat(Math.ceil(RUN_INSPECTION_LIMITS.responseBytes / 4))
    snapshot.run.input = { text }
    const raw = { run: snapshot.run, stopRequested: false, cleanupPending: false }
    expect(JSON.stringify(raw).length).toBeLessThan(RUN_INSPECTION_LIMITS.responseBytes)
    expect(Buffer.byteLength(JSON.stringify(raw), 'utf8')).toBeGreaterThan(RUN_INSPECTION_LIMITS.responseBytes)
    expect(RunRecordDetailSchema.safeParse(raw).success).toBe(false)
    await expect(service.record(caller, input)).rejects.toMatchObject({ code: 'RUN_INSPECTION_TOO_LARGE', status: 409 })
    expect(snapshot.run.input).toEqual({ text })
    expect(query).not.toHaveBeenCalled()
  })

  it('requires both persisted lifecycle facts and excludes history from the response contract', async () => {
    const record = await service.record(caller, input)
    for (const key of ['cleanupPending', 'stopRequested'] as const) {
      const raw = { ...record } as Record<string, unknown>; delete raw[key]
      expect(RunRecordDetailSchema.safeParse(raw).success).toBe(false)
    }
    for (const extra of ['executions', 'activity', 'occurrences', 'version', 'configurations']) {
      expect(RunRecordDetailSchema.safeParse({ ...record, [extra]: [] }).success).toBe(false)
    }
    expect(RunRecordGetInputSchema.parse(input)).toEqual(input)
    expect(z.toJSONSchema(RunRecordDetailSchema, { unrepresentable: 'any' }).type).toBe('object')
  })

  it.each([['ACCESS_DENIED', 403], ['RUN_NOT_FOUND', 404], ['RUN_PIN_CONFLICT', 409]] as const)(
    'retains the shared reader’s %s instead of weakening authorization or pins', async (code, status) => {
      vi.mocked(withCurrentRunRead).mockRejectedValueOnce(new DomainError(code, 'Exact read rejected', status))
      await expect(service.record(caller, input)).rejects.toMatchObject({ code, status })
      expect(query).not.toHaveBeenCalled()
    })
})

describe('Run record MCP discovery and hidden-call audit', () => {
  it('needs only compatible runs:read grants and audits a hidden direct call exactly once', async () => {
    const context = { principal: live, services: { runs: { inspection: service },
      commands: { recordDenied: vi.fn().mockResolvedValue(undefined) } } } as unknown as OperatorRequestContext
    expect(CurrentOperatorToolNameSchema.parse(RUN_INSPECTION_TOOLS.record)).toBe('run_record_get')
    expect(runInspectionRequirements(RUN_INSPECTION_TOOLS.record)).toEqual(['runs:read'])
    expect(runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.record)).toBe(true)
    expect(runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.version)).toBe(false)
    expect(runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.record, { workspaceId: input.workspaceId, runId: 'foreign-run' })).toBe(false)
    context.principal = principal([])
    const result = await unavailableRunInspectionToolCall(context, { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: RUN_INSPECTION_TOOLS.record, arguments: input } })
    expect(result?.result.isError).toBe(true)
    expect(result?.result.content).toEqual([{ type: 'text', text: expect.stringContaining('ACCESS_DENIED') }])
    expect(context.services.commands.recordDenied).toHaveBeenCalledTimes(1)
    expect(context.services.commands.recordDenied).toHaveBeenCalledWith(
      context.principal.id, 'mcp', RUN_INSPECTION_TOOLS.record, `mcp:${RUN_INSPECTION_TOOLS.record}`)
    expect(withCurrentRunRead).not.toHaveBeenCalled()
  })
})
