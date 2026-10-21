import type { AgentForm } from './agentForm'
import type { GraphDraftOperationV3, GraphEditIntentV3, WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { hasAgentEdits, rebaseAgentEdits, referencedAgentEdits, snapshotAgentEdits, type DraftAgentEdits } from './agentEdits'
import { hasLocalChanges, sameValue, type AuthoringIssue, type NextDraftContext } from './model'

/** Opaque workspace/workflow IDs are encoded, never ambiguously concatenated. */
export function nextDraftKey(workspaceId: string, workflowId: string): string {
  return `next-draft:${JSON.stringify([workspaceId, workflowId])}`
}

export type DraftFailure = { code: string; message: string; uncertain: boolean; issues?: AuthoringIssue[] }
export type WritePlan = { target: WorkflowDefinitionV3; operations: GraphDraftOperationV3[]; publish: boolean; agentTarget?: DraftAgentEdits }
export type DraftRequest = {
  kind: 'apply' | 'save'
  commandId: string
  workspaceId: string
  workflowId: string
  draftId: string
  expectedRevision: number
  executionSemanticsVersion: 3
  operations?: GraphDraftOperationV3[]
}
export type NextDraftEdit = {
  instanceId: string
  context: NextDraftContext
  graph: WorkflowDefinitionV3
  history: WorkflowDefinitionV3[]
  /** Number of older draft steps evicted from the bounded history. */
  historyOffset?: number
  future?: { graph: WorkflowDefinitionV3; agentEdits: DraftAgentEdits }[]
  agentEdits?: DraftAgentEdits
  agentForms?: Record<string, AgentForm>
  agentHistory?: DraftAgentEdits[]
  /** Local form provenance from authenticated hydration, never a command submission. */
  remoteEditIntent?: Pick<GraphEditIntentV3, 'id' | 'ownerPrincipalId' | 'stageCommandId' | 'stageInputHash'>
  busy: boolean
  plan?: WritePlan
  /** Retained verbatim after an ambiguous response. A retry uses this exact command. */
  pending?: DraftRequest
  error?: DraftFailure
  validation?: { revision: number; valid: boolean; issues: AuthoringIssue[] }
  startRejectedVersionId?: string
  startCanceled?: boolean
}

export function newNextDraft(context: NextDraftContext, instanceId: string): NextDraftEdit {
  return { instanceId, context, graph: context.draft.graph, history: [], busy: false }
}

export function editNextDraft(current: NextDraftEdit, update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3): NextDraftEdit {
  const updated = update(current.graph)
  // Server stamps are not authored changes. Geometry remains in history for intentional layout edits.
  const graph = { ...updated, version: current.graph.version, createdAt: current.graph.createdAt, updatedAt: current.graph.updatedAt }
  if (sameValue(graph, current.graph)) return current
  return { ...current, graph, history: [...current.history.slice(-49), current.graph],
    historyOffset: (current.historyOffset ?? 0) + Math.max(0, current.history.length - 49),
    future: [], validation: undefined,
    ...(current.agentHistory ? { agentEdits: referencedAgentEdits(graph, current.agentEdits),
      agentHistory: [...current.agentHistory.slice(-49), snapshotAgentEdits(current)] } : {}),
    // Typing cannot clear an unresolved command or an authorization/conflict error.
    error: current.error }
}

export function undoNextDraft(current: NextDraftEdit): NextDraftEdit {
  const previous = current.history.at(-1)
  if (!previous) return current
  // Content only: base revision and acknowledged configuration pins never rewind.
  const base = current.context.draft.graph
  return { ...current, graph: { ...previous, version: base.version, createdAt: base.createdAt, updatedAt: base.updatedAt },
    history: current.history.slice(0, -1), validation: undefined,
    future: [...(current.future ?? []).slice(-49), { graph: current.graph, agentEdits: snapshotAgentEdits(current) }],
    ...(current.agentHistory ? { agentEdits: rebaseAgentEdits(current.agentHistory.at(-1) ?? {}, current.context), agentHistory: current.agentHistory.slice(0, -1) } : {}) }
}

export function redoNextDraft(current: NextDraftEdit): NextDraftEdit {
  const next = current.future?.at(-1)
  if (!next) return current
  const base = current.context.draft.graph
  return { ...current, graph: { ...next.graph, version: base.version, createdAt: base.createdAt, updatedAt: base.updatedAt },
    agentEdits: rebaseAgentEdits(next.agentEdits, current.context), history: [...current.history.slice(-49), current.graph],
    historyOffset: (current.historyOffset ?? 0) + Math.max(0, current.history.length - 49),
    agentHistory: [...(current.agentHistory ?? current.history.map(() => ({}))).slice(-49), snapshotAgentEdits(current)],
    future: current.future!.slice(0, -1), validation: undefined }
}

export function nextDraftDirty(edit: NextDraftEdit): boolean {
  const saved = edit.context.savedDraft
  return hasLocalChanges(saved ? { ...edit.context, draft: saved } : edit.context, edit.graph)
    || hasAgentEdits(edit) || !!edit.pending
    || (!saved && edit.context.draft.publishedRevision !== edit.context.draft.revision)
}

export function canUndoNextDraft(edit: NextDraftEdit): boolean {
  return edit.history.length > 0 && (nextDraftDirty(edit) || hasAgentEdits(undoNextDraft(edit)))
}

export type NextDraftSlice = {
  nextDrafts: Record<string, NextDraftEdit>
  installNextDraft: (key: string, context: NextDraftContext, replace?: boolean) => void
  changeNextDraft: (key: string, update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3) => void
  undoNextDraft: (key: string) => void
  redoNextDraft: (key: string) => void
  updateNextDraft: (key: string, update: (edit: NextDraftEdit) => NextDraftEdit) => void
  dropNextDraft: (key: string) => void
}

type SetSlice = (update: (state: NextDraftSlice) => Partial<NextDraftSlice>) => void

/** A slice of the existing draft owner, not a second runtime or query-fact store. */
export function createNextDraftSlice(set: SetSlice): NextDraftSlice {
  const update = (key: string, change: (edit: NextDraftEdit) => NextDraftEdit) => set((state) => {
    const current = state.nextDrafts[key]
    if (!current) return state
    let next = change(current)
    if (next.context.draft.revision !== current.context.draft.revision
      || next.context.draft.baseWorkflowVersionId !== current.context.draft.baseWorkflowVersionId) next = { ...next, future: [] }
    return next === current ? state : { nextDrafts: { ...state.nextDrafts, [key]: next } }
  })
  return {
    nextDrafts: {},
    installNextDraft: (key, context, replace = false) => set((state) => {
      const current = state.nextDrafts[key]
      if (current && (!replace || current.busy || current.pending)) return state
      return { nextDrafts: { ...state.nextDrafts, [key]: newNextDraft(context, crypto.randomUUID()) } }
    }),
    changeNextDraft: (key, change) => update(key, (edit) => editNextDraft(edit, change)),
    undoNextDraft: (key) => update(key, undoNextDraft),
    redoNextDraft: (key) => update(key, redoNextDraft),
    updateNextDraft: update,
    dropNextDraft: (key) => set((state) => {
      const current = state.nextDrafts[key]
      if (!current || current.busy || current.pending) return state
      const nextDrafts = { ...state.nextDrafts }; delete nextDrafts[key]
      return { nextDrafts }
    }),
  }
}
