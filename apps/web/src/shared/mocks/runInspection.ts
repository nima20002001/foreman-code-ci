import { HttpResponse } from 'msw'
import { RunEventsPageSchema } from '@foreman-code/contracts/management'
import {
  CurrentRunVersionSnapshotSchema, RunExecutionBindingsListInputSchema, RunExecutionBindingsPageSchema,
  RunExecutionDetailSchema, RunExecutionsListInputSchema, RunExecutionsPageSchema, RunVersionDetailSchema,
  sameWorkflowValue, type CurrentRunDetails, type RepeatGraphScopeV3, type RunExecutionBinding,
  type RunExecutionDetail, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'

/** Test-owned accepted facts, never inferred from native terminal reports or from
 * a node's attempt number. Ordinary fixture executions omit occurrence. */
export type RunInspectionFixture = { detail: RunExecutionDetail; bindings: RunExecutionBinding[] }
export type RunInspectionActivity = ReturnType<typeof RunEventsPageSchema.parse>['items'][number]

/** Scoped keyset cursor for deterministic MSW tests, NOT the production cursor
 * implementation. A cursor cannot be reused with another Run or filter. */
export function inspectionFixturePage<T>(items: readonly T[], id: (item: T) => string, key: unknown,
  params: URLSearchParams, defaultLimit: number, maxLimit = defaultLimit) {
  const limit = Number(params.get('limit') ?? defaultLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new Error('INVALID_LIMIT')
  const ordered = [...items]
  let start = 0
  const cursor = params.get('cursor')
  if (cursor !== null) {
    const parsed: unknown = JSON.parse(cursor)
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 'inspection-msw'
      || !sameWorkflowValue(parsed[1], key) || typeof parsed[2] !== 'string') throw new Error('INVALID_CURSOR')
    const previous = ordered.findIndex((item) => id(item) === parsed[2])
    if (previous < 0) throw new Error('INVALID_CURSOR')
    start = previous + 1
  }
  const page = ordered.slice(start, start + limit)
  return { items: page, pageInfo: { nextCursor: start + page.length < ordered.length && page.length
    ? JSON.stringify(['inspection-msw', key, id(page.at(-1)!)]) : null } }
}

export function inspectionScopeForRun({ run }: CurrentRunDetails): RepeatGraphScopeV3 {
  return { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
}
const missing = () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Exact inspection fixture unavailable.' } }, { status: 404 })

/** Shared by createCurrentBoardMock's registered HTTP handlers and focused tests.
 * All four lane A routes use their actual shared schemas. */
export function runInspectionFixtureResponse(url: URL, tail: string, detail: CurrentRunDetails,
  version: WorkflowVersionV3 | undefined, fixtures: readonly RunInspectionFixture[]) {
  const scope = inspectionScopeForRun(detail)
  if (tail === '/version') {
    if (!version) return missing()
    CurrentRunVersionSnapshotSchema.parse({ run: detail.run, version })
    return HttpResponse.json(RunVersionDetailSchema.parse({ scope, version }))
  }
  const run = { ...scope, executionState: detail.run.executionState, outcome: detail.run.outcome,
    createdAt: detail.run.createdAt, startedAt: detail.run.startedAt, finishedAt: detail.run.finishedAt,
    stopCause: detail.run.stopCause, cleanupPending: detail.cleanupPending ?? true }
  if (tail === '/executions') {
    const input = RunExecutionsListInputSchema.parse({ ...Object.fromEntries(url.searchParams),
      workspaceId: scope.workspaceId, runId: scope.runId, limit: Number(url.searchParams.get('limit') ?? 25) })
    const items = fixtures.map((item) => item.detail.execution)
      .filter((execution) => (!input.workflowNodeId || execution.workflowNodeId === input.workflowNodeId)
        && (!input.occurrenceId || execution.occurrence?.occurrenceId === input.occurrenceId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.executionId.localeCompare(b.executionId))
    const page = inspectionFixturePage(items, (item) => item.executionId,
      [scope, input.workflowNodeId ?? null, input.occurrenceId ?? null], url.searchParams, 25, 100)
    return HttpResponse.json(RunExecutionsPageSchema.parse({ run, ...page }))
  }
  const match = /^\/executions\/([^/]+)(\/bindings)?$/.exec(tail)
  if (!match) return undefined
  const executionId = decodeURIComponent(match[1]!)
  const fixture = fixtures.find((item) => item.detail.execution.executionId === executionId)
  if (!fixture) return missing()
  if (!sameWorkflowValue(inspectionScopeForRun(detail), {
    workspaceId: fixture.detail.run.workspaceId, workflowId: fixture.detail.run.workflowId,
    runId: fixture.detail.run.runId, workflowVersionId: fixture.detail.run.workflowVersionId,
    executionSemanticsVersion: fixture.detail.run.executionSemanticsVersion,
  })) throw new Error('INSPECTION_FIXTURE_SCOPE_MISMATCH')
  if (!match[2]) return HttpResponse.json(RunExecutionDetailSchema.parse({ ...fixture.detail, run }))
  RunExecutionBindingsListInputSchema.parse({ ...Object.fromEntries(url.searchParams),
    workspaceId: scope.workspaceId, runId: scope.runId, executionId, limit: Number(url.searchParams.get('limit') ?? 10) })
  const page = inspectionFixturePage([...fixture.bindings].sort((a, b) => a.ordinal - b.ordinal),
    (item) => item.bindingId, [scope, executionId, 'bindings'], url.searchParams, 10, 25)
  return HttpResponse.json(RunExecutionBindingsPageSchema.parse({
    scope, executionId, inputDigest: fixture.detail.acceptedInput.digest, ...page,
  }))
}
