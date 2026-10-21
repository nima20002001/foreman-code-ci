import { MemoryBoardSearchSchema } from '../memoryBoardViews.js'
import { z } from 'zod'
import { UrlSearchSelectionSchema } from '../index.js'
import { GraphIdSchema } from './graphPrimitives.js'
import { RepeatGraphScopeV3Schema, sameCanonicalGraphScope, type RepeatGraphScopeV3 } from './repeatGraphMetadata.js'
import { RunActivityPublicKindSchema } from './runActivities.js'

const WorkspaceBoardInspectionSchema = z.object({
  runNodeId: GraphIdSchema.optional(), runRelationshipId: GraphIdSchema.optional(),
  runExchangeKey: z.string().min(1).max(2048).optional(),
}).strict()
export type WorkspaceBoardInspection = z.infer<typeof WorkspaceBoardInspectionSchema>

/**
 * The existing runExchangeKey travels through both mounted route aliases. Reserve
 * an unambiguous namespace for execution/occurrence inspection; ordinary graph
 * exchange keys retain their meaning. IDs cannot contain '/', and '-' is not an ID.
 * No additional route-local mirror of this linkable state is needed.
 */
const WorkspaceBoardExecutionSelectionSchema = z.object({
  occurrenceId: GraphIdSchema.optional(), executionId: GraphIdSchema.optional(),
}).strict()
export type WorkspaceBoardExecutionSelection = z.infer<typeof WorkspaceBoardExecutionSelectionSchema>

/** One shell rail; feature panels share the selected node and immutable execution pins. */
export const BoardSidePanelSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('group_chat') }).strict(),
  z.object({ kind: z.literal('agent'), nodeId: GraphIdSchema,
    tab: z.enum(['chat', 'settings', 'details']), executionId: GraphIdSchema.optional(), waitingActivationId: GraphIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('browser'), nodeId: GraphIdSchema.optional(), executionId: GraphIdSchema.optional(),
    waitingActivationId: GraphIdSchema.optional(), sessionId: GraphIdSchema.optional(), tabId: GraphIdSchema.optional() }).strict(),
]).superRefine((panel, context) => {
  if ((panel.kind === 'agent' || panel.kind === 'browser') && panel.executionId && panel.waitingActivationId) context.addIssue({ code: 'custom',
    path: ['waitingActivationId'], message: 'Select either an execution or a waiting coordinator.' })
});
export type BoardSidePanel = z.infer<typeof BoardSidePanelSchema>

const BoardSurfaceSelectionFields = {
  boardView: z.enum(['graph', 'overview']).optional(),
  boardPanel: z.enum(['group_chat', 'agent', 'browser']).optional(),
  boardAgentTab: z.enum(['chat', 'settings', 'details']).optional(),
  boardNodeId: GraphIdSchema.optional(), boardExecutionId: GraphIdSchema.optional(),
  boardWaitingActivationId: GraphIdSchema.optional(),
  boardTeamId: GraphIdSchema.optional(),
  browserSessionId: GraphIdSchema.optional(), browserTabId: GraphIdSchema.optional(),
  groupRunId: GraphIdSchema.optional(), groupPostId: GraphIdSchema.optional(), groupReceiptId: GraphIdSchema.optional(),
  boardMemory: z.union([z.literal(true), z.literal('true').transform(() => true as const)]).optional(),
}
export function runInspectionKey(selection: WorkspaceBoardExecutionSelection): string | undefined {
  const value = WorkspaceBoardExecutionSelectionSchema.parse(selection)
  return value.occurrenceId || value.executionId
    ? `inspection/${value.occurrenceId ?? '-'}/${value.executionId ?? '-'}` : undefined
}
export function readRunInspectionKey(key?: string): WorkspaceBoardExecutionSelection {
  if (!key?.startsWith('inspection/')) return {}
  const parts = key.split('/')
  if (parts.length !== 3) throw new Error('Invalid execution inspection selection.')
  const value = WorkspaceBoardExecutionSelectionSchema.parse({
    ...(parts[1] !== '-' ? { occurrenceId: parts[1] } : {}),
    ...(parts[2] !== '-' ? { executionId: parts[2] } : {}),
  })
  if (!value.occurrenceId && !value.executionId) throw new Error('Empty execution inspection selection.')
  return value
}

/** Presentation only. A URL requests a Run; it never authorizes or proves its pins. */
export const WorkspaceBoardSearchSchema = UrlSearchSelectionSchema.extend({
  ...BoardSurfaceSelectionFields,
  ...MemoryBoardSearchSchema.shape,
  ...WorkspaceBoardInspectionSchema.shape,
  activityKind: RunActivityPublicKindSchema.optional(), activityAgentId: GraphIdSchema.optional(),
  runId: GraphIdSchema.optional(),
  workflowVersionId: GraphIdSchema.optional(),
  executionSemanticsVersion: z.union([
    z.literal(3), z.literal('3').transform(() => 3 as const),
  ]).optional(),
}).strict().superRefine((value, context) => {
  if (value.runNodeId && value.runRelationshipId) context.addIssue({ code: 'custom', message: 'Inspect one Run node or relationship at a time.' })
  if (value.boardPanel === 'agent' && !value.boardNodeId) context.addIssue({ code: 'custom', path: ['boardNodeId'], message: 'Agent panels require a selected node.' })
  if (value.boardExecutionId && !value.boardNodeId) context.addIssue({ code: 'custom', path: ['boardExecutionId'], message: 'Execution selection requires its node.' })
  if (value.boardWaitingActivationId && !value.boardNodeId) context.addIssue({ code: 'custom', path: ['boardWaitingActivationId'], message: 'Consultation selection requires its node.' })
  if (value.boardExecutionId && value.boardWaitingActivationId) context.addIssue({ code: 'custom', path: ['boardWaitingActivationId'], message: 'Select either an execution or a waiting coordinator.' })
  try { readRunInspectionKey(value.runExchangeKey) }
  catch { context.addIssue({ code: 'custom', path: ['runExchangeKey'], message: 'Invalid execution or occurrence inspection identity.' }) }
  const pins = [value.runId, value.workflowVersionId, value.executionSemanticsVersion]
  if (pins.some((pin) => pin !== undefined) && (!value.workflowId || pins.some((pin) => pin === undefined))) {
    context.addIssue({ code: 'custom', message: 'A Run selection needs its workflow, Run, immutable version and execution semantics.' })
  }
})
export type WorkspaceBoardSearch = z.infer<typeof WorkspaceBoardSearchSchema>
export const WorkflowBoardSearchSchema = WorkspaceBoardSearchSchema
export type WorkflowBoardSelection = WorkspaceBoardSearch

export function boardSidePanelFromSearch(search: WorkspaceBoardSearch): BoardSidePanel {
  switch (search.boardPanel) {
    case 'group_chat': return { kind: 'group_chat' }
    case 'agent': return BoardSidePanelSchema.parse({ kind: 'agent', nodeId: search.boardNodeId,
      tab: search.boardAgentTab ?? 'chat', ...(search.boardExecutionId ? { executionId: search.boardExecutionId } : {}),
      ...(search.boardWaitingActivationId ? { waitingActivationId: search.boardWaitingActivationId } : {}) })
    case 'browser': return { kind: 'browser', ...(search.boardNodeId ? { nodeId: search.boardNodeId } : {}),
      ...(search.boardExecutionId ? { executionId: search.boardExecutionId } : {}),
      ...(search.boardWaitingActivationId ? { waitingActivationId: search.boardWaitingActivationId } : {}),
      ...(search.browserSessionId ? { sessionId: search.browserSessionId } : {}), ...(search.browserTabId ? { tabId: search.browserTabId } : {}) }
    default: return { kind: 'none' }
  }
}
export type WorkflowBoardLocation = {
  workspaceId: string; workflowId?: string; search: WorkspaceBoardSearch
  run?: RepeatGraphScopeV3; draftAlias: boolean
}

/** Pinned deep links resolve in the SAME mounted workspace route. No automatic redirect. */
export function resolveWorkflowBoardLocation(pathname: string, rawSearch: unknown): WorkflowBoardLocation {
  const match = /^\/workspaces\/([^/]+)(?:\/workflows\/([^/]+)\/(draft|runs\/([^/]+)\/graph\/([^/]+)\/(3)))?\/?$/.exec(pathname)
  if (!match) throw new Error('Invalid workflow board URL.')
  const workspaceId = decodeURIComponent(match[1]!)
  const pathWorkflowId = match[2] === undefined ? undefined : decodeURIComponent(match[2])
  const search = WorkspaceBoardSearchSchema.parse(rawSearch)
  if ((search.workspaceId !== undefined && search.workspaceId !== workspaceId)
    || (pathWorkflowId !== undefined && search.workflowId !== undefined && pathWorkflowId !== search.workflowId)) {
    throw new Error('The board URL contains conflicting workspace or workflow identities.')
  }
  const workflowId = pathWorkflowId ?? search.workflowId
  const requested = search.runId === undefined ? undefined : RepeatGraphScopeV3Schema.parse({
    workspaceId, workflowId, runId: search.runId, workflowVersionId: search.workflowVersionId,
    executionSemanticsVersion: search.executionSemanticsVersion,
  })
  const pinned = match[4] === undefined ? undefined : RepeatGraphScopeV3Schema.parse({
    workspaceId, workflowId, runId: decodeURIComponent(match[4]), workflowVersionId: decodeURIComponent(match[5]!),
    executionSemanticsVersion: Number(match[6]),
  })
  if (pinned && requested && !sameCanonicalGraphScope(pinned, requested)) throw new Error('The Run URL contains conflicting immutable pins.')
  if ((search.runNodeId || search.runRelationshipId || search.runExchangeKey) && !pinned && !requested) throw new Error('Run inspection needs a complete Run selection.')
  if ((search.boardExecutionId || search.boardWaitingActivationId) && !pinned && !requested) throw new Error('Board execution or consultation selection needs a complete Run selection.')
  return { workspaceId, workflowId, search, run: pinned ?? requested, draftAlias: match[3] === 'draft' }
}

export function boardSearchForRun(search: WorkspaceBoardSearch, workflowId: string, run?: RepeatGraphScopeV3): WorkspaceBoardSearch {
  if (run && (run.workflowId !== workflowId || search.workspaceId !== undefined && run.workspaceId !== search.workspaceId)) {
    throw new Error('Cannot select a Run from a different workspace or workflow.')
  }
  if (run) RepeatGraphScopeV3Schema.parse(run)
  const { runId: _run, workflowVersionId: _version, executionSemanticsVersion: _semantics,
    runNodeId: _node, runRelationshipId: _edge, runExchangeKey: _exchange, ...rest } = search
  void _run; void _version; void _semantics; void _node; void _edge; void _exchange
  const changedRun = search.workflowId !== workflowId || search.runId !== run?.runId
    || search.workflowVersionId !== run?.workflowVersionId
  if (changedRun) { delete rest.boardExecutionId; delete rest.boardWaitingActivationId; delete rest.browserSessionId; delete rest.browserTabId }
  return WorkspaceBoardSearchSchema.parse({ ...rest, workflowId, ...(run ? {
    runId: run.runId, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: run.executionSemanticsVersion,
  } : {}) })
}

export function boardSearchForInspection(search: WorkspaceBoardSearch, workflowId: string, run: RepeatGraphScopeV3, inspection: WorkspaceBoardInspection): WorkspaceBoardSearch {
  return WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(search, workflowId, run), ...WorkspaceBoardInspectionSchema.parse(inspection) })
}

/** Run selection and in-board surfaces retain drafts. Authoring selection changes still prompt. */
export function staysOnWorkflowBoard(current: { pathname: string; search: unknown }, next: { pathname: string; search: unknown }): boolean {
  try {
    const a = resolveWorkflowBoardLocation(current.pathname, current.search)
    const b = resolveWorkflowBoardLocation(next.pathname, next.search)
    if (a.workspaceId !== b.workspaceId || !a.workflowId || a.workflowId !== b.workflowId) return false
    const left = authoringSelection(boardSearchForRun(a.search, a.workflowId))
    const right = authoringSelection(boardSearchForRun(b.search, b.workflowId))
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof typeof left>
    return [...keys].every((key) => left[key] === right[key])
  } catch { return false }
}

function authoringSelection(search: WorkspaceBoardSearch): WorkspaceBoardSearch {
  const value = { ...search }
  for (const key of ['activityKind', 'activityAgentId', 'boardView', 'boardPanel', 'boardAgentTab',
    'browserSessionId', 'browserTabId', 'boardNodeId', 'boardExecutionId', 'boardWaitingActivationId', 'boardTeamId', 'boardMemory',
    'groupRunId', 'groupPostId', 'groupReceiptId'] as const) delete value[key]
  return value
}
