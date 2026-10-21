// @vitest-environment jsdom
import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { ApiError } from '../../../shared/api/client'
import { RunExecutionDetailSchema, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import {
  assertExecutionVersion, digestCurrentValue, readRunExecution, readRunExecutionBindings,
  readRunExecutions, readRunInspectionVersion,
} from '../runDetailsClient'
import { readBoardHistory, readBoardRuns } from '../client'
import { inspectionBoardFixture } from './inspectionFixtures'

let fixture: Awaited<ReturnType<typeof inspectionBoardFixture>>
let sequence = 0
const prefix = (scope: RepeatGraphScopeV3) => `/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}`
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  fixture = await inspectionBoardFixture(`client-inspection-${++sequence}`)
  server.use(...fixture.mock.handlers)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('authenticated current-semantics Run inspection', () => {
  it('reads the Run pin across versions before repeat, with repeat, and after removal', async () => {
    for (const owner of [fixture.runs.before, fixture.runs.repeated, fixture.runs.after]) {
      const response = await readRunInspectionVersion(owner.scope)
      expect(response.version).toEqual(owner.version)
    }
    expect(fixture.before.definition).not.toHaveProperty('repeat')
    expect(fixture.after.definition).not.toHaveProperty('repeat')
    expect(fixture.repeated.definition.repeat?.blocks).toHaveLength(1)
    expect(fixture.mock.calls.filter((call) => call.path.endsWith('/version'))).toHaveLength(3)
    expect(fixture.mock.calls.some((call) => call.path.includes('/workflows/') || call.path.includes('/agents/'))).toBe(false)
  })

  it('does not substitute another saved version returned for this Run', async () => {
    const owner = fixture.runs.before
    server.use(http.get(`${prefix(owner.scope)}/version`, () => HttpResponse.json({
      scope: owner.scope, version: fixture.after,
    })))
    const read = readRunInspectionVersion(owner.scope)
    await expect(read).rejects.toBeInstanceOf(ApiError)
    await expect(read).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
      details: { issues: [{ path: [], message: 'RUN_VERSION_SNAPSHOT_PIN_MISMATCH' }] },
    })
  })

  it('does not invent ordinary occurrences from technical attempts', async () => {
    const { scope } = fixture.runs.before
    const encodedId = `${fixture.ordinaryExecutions[1]!.detail.execution.executionId}:exact`
    fixture.ordinaryExecutions[1]!.detail.execution.executionId = encodedId
    const page = await readRunExecutions(scope)
    expect(page.items.map((item) => item.attempt)).toEqual([1, 2])
    expect((await readRunExecution(scope, encodedId)).execution.executionId).toBe(encodedId)
    expect(page.items.every((item) => !Object.hasOwn(item, 'occurrence'))).toBe(true)
    for (const item of page.items) expect(() => assertExecutionVersion(fixture.before, item)).not.toThrow()
  })

  it('discovers an exact occurrence without conflating two technical attempts', async () => {
    const { scope } = fixture.runs.repeated
    const occurrence = fixture.repeatedExecutions[1]!.detail.execution.occurrence!
    const page = await readRunExecutions(scope, { workflowNodeId: fixture.second.id, occurrenceId: occurrence.occurrenceId })
    expect(page.items.map((item) => item.attempt)).toEqual([1, 2])
    expect(page.items.every((item) => item.occurrence?.occurrenceIndex === 2)).toBe(true)
    expect(page.items.map((item) => item.executionId)).toEqual(
      fixture.repeatedExecutions.slice(1, 3).map((item) => item.detail.execution.executionId))
  })

  it('reads accepted input/result even when the execution is outside the compact current cut', async () => {
    const owner = fixture.runs.repeated, expected = fixture.repeatedExecutions[2]!.detail
    expect(fixture.mock.currents.get(owner.run.id)?.state.executions).toEqual([])
    const detail = await readRunExecution(owner.scope, expected.execution.executionId)
    expect(detail.execution).toEqual(expected.execution)
    expect(detail.acceptedInput).toEqual(expected.acceptedInput)
    expect(detail.acceptedResult).toEqual(expected.acceptedResult)
    expect(fixture.mock.calls.some((call) => call.path.includes('/graph'))).toBe(false)
  })

  it('keeps a native failed report separate from accepted predecessor output', async () => {
    const owner = fixture.runs.before, execution = fixture.ordinaryExecutions[0]!.detail.execution
    const detail = await readRunExecution(owner.scope, execution.executionId)
    expect(detail.reportedResult?.outcome).toBe('failed')
    expect(detail.acceptedResult).toEqual({ status: 'not_accepted' })
    expect(detail.execution.acceptedResultAvailable).toBe(false)
  })

  it('rejects a result value whose accepted digest belongs to a different result', async () => {
    const owner = fixture.runs.repeated, source = fixture.repeatedExecutions[2]!.detail
    server.use(http.get(`${prefix(owner.scope)}/executions/${source.execution.executionId}`, () => HttpResponse.json({
      ...source, acceptedResult: { ...source.acceptedResult, value: { outcome: 'succeeded', output: 'wrong result' } },
    })))
    await expect(readRunExecution(owner.scope, source.execution.executionId)).rejects.toThrow(/digest/)
  })

  it('rejects an input value swapped between occurrences', async () => {
    const owner = fixture.runs.repeated, source = fixture.repeatedExecutions[2]!.detail
    const other = fixture.repeatedExecutions[0]!.detail
    server.use(http.get(`${prefix(owner.scope)}/executions/${source.execution.executionId}`, () => HttpResponse.json({
      ...source, acceptedInput: other.acceptedInput,
    })))
    await expect(readRunExecution(owner.scope, source.execution.executionId)).rejects.toThrow(/occurrence/)
  })

  it('rejects a page which ignores its node filter', async () => {
    const owner = fixture.runs.repeated, source = fixture.repeatedExecutions[0]!.detail
    server.use(http.get(`${prefix(owner.scope)}/executions`, () => HttpResponse.json({
      run: source.run, items: [source.execution], pageInfo: { nextCursor: null },
    })))
    await expect(readRunExecutions(owner.scope, { workflowNodeId: fixture.first.id })).rejects.toThrow(/filter/)
  })

  it('rejects wrong Run and configuration identities rather than presenting draft facts', async () => {
    const owner = fixture.runs.repeated, source = fixture.repeatedExecutions[2]!.detail
    server.use(http.get(`${prefix(owner.scope)}/executions/${source.execution.executionId}`, () => HttpResponse.json({
      ...source, run: { ...source.run, runId: 'another-run' },
    })))
    await expect(readRunExecution(owner.scope, source.execution.executionId)).rejects.toThrow(/pins/)
    expect(() => assertExecutionVersion(fixture.repeated, {
      ...nativeNode(source.execution), agentConfigurationVersionId: 'current-but-not-pinned',
    })).toThrow(/immutable/)
    expect(() => assertExecutionVersion(fixture.before, source.execution)).toThrow(/immutable/)
  })

  it('pages explicitly and returns a bounded first page after a caller refresh', async () => {
    const owner = fixture.runs.before
    const executions = await Promise.all(Array.from({ length: 31 }, (_, index) => fixture.execution(owner, 0, undefined, index + 1)))
    for (const item of executions.slice(0, -1)) {
      item.detail = RunExecutionDetailSchema.parse({ ...item.detail,
        execution: { ...item.detail.execution, acceptedResultAvailable: false }, acceptedResult: { status: 'not_accepted' } })
    }
    fixture.mock.inspection.set(owner.run.id, executions)
    const first = await readRunExecutions(owner.scope)
    expect(first.items).toHaveLength(25)
    expect(first.pageInfo.nextCursor).not.toBeNull()
    const next = await readRunExecutions(owner.scope, {}, first.pageInfo.nextCursor)
    expect(next.items).toHaveLength(6)
    expect(new Set([...first.items, ...next.items].map((item) => item.executionId)).size).toBe(31)
    expect(next.pageInfo.nextCursor).toBeNull()
    expect((await readRunExecutions(owner.scope)).items).toEqual(first.items)
  })

  it('refuses non-advancing cursors', async () => {
    const owner = fixture.runs.before, detail = fixture.ordinaryExecutions[0]!.detail
    server.use(http.get(`${prefix(owner.scope)}/executions`, () => HttpResponse.json({
      run: detail.run, items: [], pageInfo: { nextCursor: 'stuck' },
    })))
    await expect(readRunExecutions(owner.scope, {}, 'stuck')).rejects.toThrow(/advance/)
  })

  it('verifies exact recipient, accepted input and predecessor identity for bindings', async () => {
    const owner = fixture.runs.repeated, expected = fixture.repeatedExecutions[2]!
    const detail = await readRunExecution(owner.scope, expected.detail.execution.executionId)
    const page = await readRunExecutionBindings(owner.scope, detail)
    expect(page.items).toEqual(expected.bindings)
    expect(page.inputDigest).toBe(detail.acceptedInput.digest)
  })

  it('rejects a binding source not in the accepted input even with a valid result digest', async () => {
    const owner = fixture.runs.repeated, source = fixture.repeatedExecutions[2]!
    const binding = source.bindings[0]!
    server.use(http.get(`${prefix(owner.scope)}/executions/${source.detail.execution.executionId}/bindings`, () => HttpResponse.json({
      scope: owner.scope, executionId: source.detail.execution.executionId, inputDigest: source.detail.acceptedInput.digest,
      items: [{ ...binding, source: { ...binding.source, execution: { ...binding.source.execution, executionId: 'wrong-sender' } } }],
      pageInfo: { nextCursor: null },
    })))
    await expect(readRunExecutionBindings(owner.scope, source.detail)).rejects.toThrow(/binding/i)
  })

  it('loads historical activity in two explicit scoped pages', async () => {
    const { scope } = fixture.runs.repeated
    const first = await readBoardHistory(scope, null)
    expect(first.items).toHaveLength(50)
    const next = await readBoardHistory(scope, first.pageInfo.nextCursor)
    expect(next.items.map((item) => item.sequence)).toEqual([50, 51])
    expect(next.pageInfo.nextCursor).toBeNull()
  })

  it('keeps runs of different saved V3 versions in one workflow list', async () => {
    const items = await readBoardRuns(fixture.mock.workspaceId, fixture.before.workflowId)
    expect(items.items.map((run) => run.workflowVersionId)).toEqual([fixture.before.id, fixture.repeated.id, fixture.after.id])
  })

  it('fails unavailable endpoints without another history or version fallback', async () => {
    const owner = fixture.runs.before, calls: string[] = []
    server.use(http.get(`${prefix(owner.scope)}/version`, ({ request }) => {
      calls.push(request.url)
      return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Pinned snapshot unavailable' } }, { status: 404 })
    }))
    await expect(readRunInspectionVersion(owner.scope)).rejects.toThrow(/unavailable/)
    expect(calls).toHaveLength(1)
    expect(fixture.mock.calls).toEqual([])
  })

  it('rejects retired execution tags before any request', async () => {
    for (const executionSemanticsVersion of [1, 2]) {
      const scope = { ...fixture.runs.before.scope, executionSemanticsVersion } as RepeatGraphScopeV3
      await expect(readRunInspectionVersion(scope)).rejects.toThrow()
      await expect(readRunExecutions(scope)).rejects.toThrow()
    }
    expect(fixture.mock.calls).toEqual([])
  })

  it('digests the exact original value rather than a prettified or extracted result', async () => {
    const value = { outcome: 'succeeded', output: { text: '{"data":{"answer":42}}' } }
    expect(await digestCurrentValue(value)).not.toBe(await digestCurrentValue(value.output))
    expect(await digestCurrentValue(value)).toBe(await digestCurrentValue({ output: value.output, outcome: value.outcome }))
  })
})
