import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { CanonicalRunGraphReadCapabilitiesSchema, CanonicalRunGraphScopeSchema,
  ManualRunStartInputSchema, RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { canonicalRunGraphReadApi } from '../src/modules/run-graph/repeatReadService.js'

const scope = { workspaceId: 'workspace-test', workflowId: 'workflow-test', workflowVersionId: 'version-test', runId: 'run-test', executionSemanticsVersion: 3 as const }
const principal = ManagementPrincipalSchema.parse({ id: 'principal-test', name: 'Read-only contract test', audience: 'operator',
  expiresAt: '2999-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['runs:read', 'capabilities:read'], scope: {} }] })
const start = { workspaceId: scope.workspaceId, workflowId: scope.workflowId, workflowVersionId: scope.workflowVersionId,
  commandId: randomUUID(), input: {}, expectedLocationRevision: 1, executionSemanticsVersion: 3, expectedWorkflowRevision: 2,
  expectedAgentConfigurationVersionIds: { 'agent-test': 'configuration-test' } }

function rejectsCode(work: () => unknown, code: string) {
  let failure: unknown
  try { work() } catch (error) { failure = error }
  expect(failure).toMatchObject({ code })
}

describe('read discovery and manual Start contracts', () => {
  it('has exactly one current Start arm without adding repeat to the command', () => {
    expect(ManualRunStartInputSchema.parse(start)).toEqual(RunStartV3InputSchema.parse(start))
    expect(Object.hasOwn(ManualRunStartInputSchema.parse(start), 'repeat')).toBe(false)
  })
  it.each(['workflowVersionId', 'expectedWorkflowRevision', 'expectedAgentConfigurationVersionIds', 'expectedLocationRevision'])(
    'requires the current %s pin', (key) => {
      const input: Record<string, unknown> = { ...start }; delete input[key]
      expect(ManualRunStartInputSchema.safeParse(input).success).toBe(false)
    })
  it('generates an omitted command ID and preserves an explicit retry ID', () => {
    const { commandId, ...input } = start
    expect(ManualRunStartInputSchema.parse(input).commandId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ManualRunStartInputSchema.parse(start).commandId).toBe(commandId)
    expect(ManualRunStartInputSchema.safeParse({ ...start, commandId: '' }).success).toBe(false)
  })
  it.each([undefined, 1, 2, 0, 4, '3', null, '03'])('does not reinterpret retired/unknown tag %s', (executionSemanticsVersion) => {
    expect(ManualRunStartInputSchema.safeParse({ ...start, executionSemanticsVersion }).success).toBe(false)
    expect(CanonicalRunGraphScopeSchema.safeParse({ ...scope, executionSemanticsVersion }).success).toBe(false)
  })
  it('rejects caller admission flags and half a displayed-draft pin', () => {
    for (const extra of [{ qualified: true }, { runtimeAdmission: true }, { repeat: { contractVersion: 1, blocks: [] } },
      { draftId: 'draft-test' }, { expectedDraftRevision: 1 }]) {
      expect(ManualRunStartInputSchema.safeParse({ ...start, ...extra }).success).toBe(false)
    }
    expect(ManualRunStartInputSchema.safeParse({ ...start, draftId: 'draft-test', expectedDraftRevision: 1 }).success).toBe(true)
  })
  it('preserves graph protocol 1 but advertises only current V3 reads, never runtime admission', () => {
    const capabilities = { capabilityVersion: 1, protocolVersions: [1], readSemanticsVersions: [3], transport: 'http_poll', activePollMs: 1000,
      semantics3: { persistedReads: true, payload: 'metadata_only', runtimeAdmission: false, meaningfulEdit: false } }
    expect(CanonicalRunGraphReadCapabilitiesSchema.parse(capabilities)).toEqual(capabilities)
    // The shared shape also represents a fully bound production runtime. A
    // qualified reader alone must still not advertise Start or meaningful edits.
    expect(CanonicalRunGraphReadCapabilitiesSchema.safeParse({ ...capabilities,
      semantics3: { ...capabilities.semantics3, runtimeAdmission: true },
    }).success).toBe(true)
    const connect = vi.fn(() => { throw new Error('Discovery must not acquire SQL') })
    const reads = new RunGraphReadService({ connect } as unknown as pg.Pool, { qualifiedReads: true })
    expect(reads.capabilities(principal).semantics3).toMatchObject({
      persistedReads: true, runtimeAdmission: false, meaningfulEdit: false,
    })
    expect(connect).not.toHaveBeenCalled()
    for (const value of [{ ...capabilities, readSemanticsVersions: [2] }, { ...capabilities, readSemanticsVersions: [2, 3] },
      { ...capabilities, protocolVersions: [] }]) {
      expect(CanonicalRunGraphReadCapabilitiesSchema.safeParse(value).success).toBe(false)
    }
  })
  it('closed reads and malformed/retired tags never acquire a SQL connection', async () => {
    const connect = vi.fn(() => { throw new Error('No SQL permitted in this negative unit test') })
    const pool = { connect } as unknown as pg.Pool
    const reads = canonicalRunGraphReadApi(new RunGraphReadService(pool))
    expect(reads.readCapabilities(principal).readSemanticsVersions).toEqual([])
    for (const kind of ['current', 'snapshot', 'events'] as const) {
      await expect(reads[kind](principal, { protocolVersion: 1, scope, ...(kind === 'events' ? { afterSequence: '0' } : {}) }))
        .rejects.toMatchObject({ code: 'GRAPH_NOT_INITIALIZED' })
    }
    const current = canonicalRunGraphReadApi(new RunGraphReadService(pool, { qualifiedReads: true }))
    for (const tag of [1, 2, 4, '3', undefined]) {
      rejectsCode(() => current.snapshot(principal, { protocolVersion: 1, scope: { ...scope, executionSemanticsVersion: tag } }), 'GRAPH_SCOPE_MISMATCH')
    }
    expect(connect).not.toHaveBeenCalled()
  })
  it('requires matching capability permissions and rejects expired/revoked/non-Operator readers', async () => {
    const connect = vi.fn(() => { throw new Error('Unauthorized read must not reach SQL') })
    const reads = new RunGraphReadService({ connect } as unknown as pg.Pool, { qualifiedReads: true })
    const noDiscovery = { ...principal, grants: [{ actions: ['runs:read' as const], scope: {} }] }
    rejectsCode(() => reads.capabilities(noDiscovery), 'GRAPH_READ_ACCESS_DENIED')
    for (const denied of [{ ...principal, revokedAt: '2026-09-25T00:00:00.000Z' }, { ...principal, expiresAt: '2000-01-01T00:00:00.000Z' },
      { ...principal, audience: 'worker' } as unknown as typeof principal]) {
      await expect(reads.snapshot(denied, { protocolVersion: 1, scope })).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    }
    expect(connect).not.toHaveBeenCalled()
  })
})
