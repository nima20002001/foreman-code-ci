import { AgentFormSchema } from './agentForm'
import { LocalWorkflowFormSchema } from './localGraph'
import { z } from 'zod'
import { AgentSchema } from '@foreman-code/contracts'
import { ManagedAgentSchema } from '@foreman-code/contracts/management'
import { GraphDraftV3Schema, GraphEditStageInputV3Schema, WorkflowDefinitionV3Schema, sameAuthoredWorkflow, sameWorkflowValue,
  type GraphEditIntentV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { chatStoragePrefix, identityEpoch, protectedKey } from '../../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../../shared/api/sessionBoundary'
import { nextDraftKey, type NextDraftEdit, type ConflictRecovery } from './state'

const prefix = 'graph-edit-intent:'
const SnapshotSchema = z.object({
  context: z.object({ draft: GraphDraftV3Schema, savedDraft: GraphDraftV3Schema.optional(), agents: z.array(ManagedAgentSchema) }).strict(),
  graph: LocalWorkflowFormSchema, agentEdits: z.record(z.string(), AgentSchema).optional(),
  agentForms: z.record(z.string(), AgentFormSchema).optional(),
  workflowForms: z.object({
    hierarchy: z.object({ masterNodeId: z.string(), parents: z.record(z.string(), z.string()),
      previousMaster: z.enum(['keep', 'remove']).optional() }).strict().optional(),
    workerParents: z.record(z.string(), z.string()).optional(),
    removeNode: z.object({ nodeId: z.string(), destinationParentId: z.string() }).strict().optional(),
  }).strict().optional(),
  remoteEditIntent: z.object({ id: z.string().min(1), ownerPrincipalId: z.string().min(1),
    stageCommandId: z.string().min(1), stageInputHash: z.string().min(1) }).strict().optional(),
  acknowledgedStageCommands: z.array(z.string()).optional(), submittedStageCommands: z.array(z.string()).optional(),
}).strict()
const OutboxSchema = z.object({ request: GraphEditStageInputV3Schema, target: WorkflowDefinitionV3Schema,
  agentTarget: z.record(z.string(), AgentSchema).optional() }).strict()
const SubmissionSchema = OutboxSchema.extend({ terminal: z.literal(true).optional() })
const ConflictRecoverySchema = z.object({ id: z.string().min(1), originalInstanceId: z.string().min(1),
  recordedAt: z.string().datetime(), snapshot: SnapshotSchema }).strict()
export type EditIntentOutbox = z.infer<typeof OutboxSchema>
const storageFailure = 'Durable edit storage is unavailable. Edits remain in this tab; no Stop or save will be sent until storage is restored.'
function storage() {
  if (sessionIsSwitching()) throw new SessionChangedError()
  if (typeof window === 'undefined') throw new Error(storageFailure)
  return window.localStorage
}
function key(kind: 'outbox' | 'draft' | 'ui', scope: string) { return protectedKey(kind, `${prefix}${scope}`) }
function read<T>(name: string, schema: z.ZodType<T>): T | undefined {
  let raw: string | null
  try { raw = storage().getItem(name) } catch { throw new Error(storageFailure) }
  if (raw === null) return undefined
  try { return schema.parse(JSON.parse(raw)) }
  catch { throw new Error('The retained edit record is invalid. It has not been deleted or replaced. Reconcile the server intent before editing.') }
}
function write(name: string, value: unknown) {
  const encoded = JSON.stringify(value)
  const attempt = () => {
    const local = storage(); local.setItem(name, encoded)
    if (local.getItem(name) !== encoded) throw new Error(storageFailure)
  }
  try { attempt() } catch {
    // Retry after removing old identity epochs and compacting recoverable forms.
    try { pruneSupersededForms(); attempt() } catch { throw new Error(storageFailure) }
  }
}
/** Old sign-in epochs are inaccessible; current forms keep their independent owners. */
function pruneSupersededForms() {
  const local = storage(), current = `${chatStoragePrefix}${identityEpoch()}:`
  const draftPrefix = protectedKey('draft'), ownTab = tab(), names: string[] = []
  for (let i = 0; i < local.length; i++) { const name = local.key(i); if (name) names.push(name) }
  for (const name of names) {
    if (name.startsWith(chatStoragePrefix) && !name.startsWith(current)) { local.removeItem(name); continue }
    if (!name.startsWith(draftPrefix)) continue
    const id = decodeURIComponent(name.slice(draftPrefix.length)), split = id.lastIndexOf(':')
    const tabId = id.slice(split + 1)
    if (!id.startsWith(prefix) || split < prefix.length || tabId === ownTab) continue
    // Copies written before forms kept only their own Agents hold the whole workspace catalog.
    try {
      const raw = local.getItem(name), snapshot = raw === null ? undefined : SnapshotSchema.parse(JSON.parse(raw))
      const agents = snapshot && referencedAgents(snapshot)
      if (snapshot && agents && agents.length < snapshot.context.agents.length) local.setItem(name, JSON.stringify({ ...snapshot, context: { ...snapshot.context, agents } }))
    } catch { /* ignore: an unreadable form stays available for reconciliation. */ }
  }
}
/** The workspace Agent catalog is server state; a form copy keeps only the Agents its forms refer to. */
function referencedAgents(edit: Pick<NextDraftEdit, 'context' | 'graph' | 'agentEdits' | 'agentForms'>) {
  const text = JSON.stringify([edit.context.draft, edit.context.savedDraft, edit.graph, edit.agentEdits, edit.agentForms])
  return edit.context.agents.filter(({ agent }) => text.includes(JSON.stringify(agent.id)))
}
function assertScope(scope: string, workspaceId: string, workflowId: string) {
  if (scope !== nextDraftKey(workspaceId, workflowId)) throw new Error('The retained edit has a different workspace or workflow.')
}
function tab() {
  // Separate unsent forms in separate tabs. The command outbox, in contrast,
  // is shared and reserved under a cross-tab lock before any HTTP effect.
  const name = key('ui', 'tab')
  let id: string | null
  try {
    id = window.sessionStorage.getItem(name)
    if (!id) { id = crypto.randomUUID(); window.sessionStorage.setItem(name, id) }
  } catch { throw new Error(storageFailure) }
  return id
}
type TabOwnership = { name: string; ready: Promise<void>; release?: () => void }
let tabOwnership: TabOwnership | undefined
function releaseTabOwnership() {
  tabOwnership?.release?.()
  tabOwnership = undefined
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', event => {
  if (!event.persisted) releaseTabOwnership()
})
/** A lifetime lock distinguishes a reload from a copied sessionStorage owner in another live document. */
export async function claimEditTabOwnership(): Promise<void> {
  const id = tab()
  const name = key('ui', `owner:${id}`)
  if (tabOwnership?.name === name) return tabOwnership.ready
  releaseTabOwnership()
  if (!navigator.locks) return Promise.reject(new Error('This browser cannot safely recover independent tab edits.'))
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const ready = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  const owner: TabOwnership = { name, ready }
  tabOwnership = owner
  const generation = sessionGeneration()
  const claim = (ownerId: string) => {
    void navigator.locks.request(key('ui', `owner:${ownerId}`), { ifAvailable: true }, async lock => {
      assertSession(generation)
      if (tabOwnership !== owner) throw new SessionChangedError()
      if (!lock) {
        const independent = crypto.randomUUID()
        claim(independent)
        return
      }
      if (ownerId !== id) {
        copyTabSnapshots(id, ownerId)
        window.sessionStorage.setItem(key('ui', 'tab'), ownerId)
        owner.name = key('ui', `owner:${ownerId}`)
      }
      await new Promise<void>(release => {
        owner.release = release
        resolve()
      })
    }).catch(reject)
  }
  claim(id)
  return ready
}
function copyTabSnapshots(from: string, to: string) {
  const local = storage()
  const start = protectedKey('draft')
  const names = Array.from({ length: local.length }, (_, index) => local.key(index))
  for (const name of names) {
    if (!name?.startsWith(start)) continue
    const scope = decodeURIComponent(name.slice(start.length))
    if (!scope.startsWith(prefix) || !scope.endsWith(`:${from}`)) continue
    const snapshot = read(name, SnapshotSchema)
    if (snapshot) write(protectedKey('draft', `${scope.slice(0, -from.length)}${to}`), snapshot)
  }
}
export function readEditSnapshot(scope: string) {
  const own = key('draft', `${scope}:${tab()}`)
  const latest = read(key('ui', `${scope}:latest`), z.string())
  // Reopening in a new tab copies the last form, then owns an independent
  // snapshot. No tab can overwrite another tab's retained unsent payload.
  const existing = read(own, SnapshotSchema)
  const value = existing ?? (latest ? read(key('draft', `${scope}:${latest}`), SnapshotSchema) : undefined)
  if (value) {
    assertScope(scope, value.context.draft.workspaceId, value.context.draft.workflowId)
    assertScope(scope, value.graph.workspaceId, value.graph.id)
    // Copy the acknowledgement metadata with the form. A new tab must not
    // replay an old Discard against edits made after this snapshot settled.
    if (!existing) write(own, value)
    return { context: value.context, graph: value.graph, agentEdits: value.agentEdits, agentForms: value.agentForms, workflowForms: value.workflowForms,
      ...(value.remoteEditIntent ? { remoteEditIntent: value.remoteEditIntent } : {}) }
  }
  return undefined
}
function sameDraftBase(left: NextDraftEdit['context']['draft'], right: NextDraftEdit['context']['draft']) {
  return left.workspaceId === right.workspaceId && left.workflowId === right.workflowId && left.id === right.id
    && left.revision === right.revision && left.baseWorkflowVersionId === right.baseWorkflowVersionId
}
function sameSnapshotForm(left: z.infer<typeof SnapshotSchema>, right: z.infer<typeof SnapshotSchema>) {
  return sameDraftBase(left.context.draft, right.context.draft) && sameWorkflowValue(left.context, right.context)
    && sameWorkflowValue(left.graph, right.graph) && sameWorkflowValue(left.agentEdits ?? {}, right.agentEdits ?? {})
    && sameWorkflowValue(left.workflowForms ?? {}, right.workflowForms ?? {})
    && sameWorkflowValue(left.remoteEditIntent, right.remoteEditIntent)
}
/** Local consumption only, not server state. Scoped to this tab and form base. */
export function editSnapshotAcknowledged(scope: string, edit: NextDraftEdit, stageCommandId: string): boolean {
  const snapshot = read(key('draft', `${scope}:${tab()}`), SnapshotSchema)
  return !!snapshot && sameDraftBase(snapshot.context.draft, edit.context.draft)
    && !!snapshot.acknowledgedStageCommands?.includes(stageCommandId)
}
/** Local lineage only. It never authorizes a server command or proves publication. */
export function editSnapshotSubmitted(scope: string, edit: NextDraftEdit, stageCommandId: string): boolean {
  const snapshot = read(key('draft', `${scope}:${tab()}`), SnapshotSchema)
  return !!snapshot && sameDraftBase(snapshot.context.draft, edit.context.draft)
    && !!snapshot.submittedStageCommands?.includes(stageCommandId)
}
export function storeEditSnapshot(scope: string, edit: Pick<NextDraftEdit, 'context' | 'graph' | 'agentEdits' | 'agentForms' | 'workflowForms' | 'remoteEditIntent'>, acknowledgedStageCommandId?: string) {
  const value = SnapshotSchema.parse({ context: { ...edit.context, agents: referencedAgents(edit) }, graph: edit.graph,
    ...(edit.agentForms ? { agentForms: edit.agentForms } : {}),
    ...(edit.workflowForms ? { workflowForms: edit.workflowForms } : {}),
    ...(edit.agentEdits ? { agentEdits: edit.agentEdits } : {}),
    ...(edit.remoteEditIntent ? { remoteEditIntent: edit.remoteEditIntent } : {}) })
  assertScope(scope, value.graph.workspaceId, value.graph.id)
  assertScope(scope, value.context.draft.workspaceId, value.context.draft.workflowId)
  const id = tab(), name = key('draft', `${scope}:${id}`), previous = read(name, SnapshotSchema)
  const latestId = !previous ? read(key('ui', `${scope}:latest`), z.string()) : undefined
  const latest = latestId && latestId !== id ? read(key('draft', `${scope}:${latestId}`), SnapshotSchema) : undefined
  // A genuinely new recovery tab may continue the exact last form lineage. An
  // already-independent tab always keeps its own metadata and cannot inherit it.
  const lineage = previous ?? (latest && sameSnapshotForm(latest, value) ? latest : undefined)
  const acknowledgedStageCommands = new Set(lineage && sameDraftBase(lineage.context.draft, value.context.draft)
    ? lineage.acknowledgedStageCommands : [])
  const submittedStageCommands = new Set(lineage && sameDraftBase(lineage.context.draft, value.context.draft)
    ? lineage.submittedStageCommands : [])
  if (acknowledgedStageCommandId) acknowledgedStageCommands.add(acknowledgedStageCommandId)
  // Form plus local command-lineage/consumption markers share one storage write.
  // These markers are local safety evidence only, never publication authority.
  write(key('ui', `${scope}:latest`), id)
  write(name, { ...value,
    ...(acknowledgedStageCommands.size ? { acknowledgedStageCommands: [...acknowledgedStageCommands] } : {}),
    ...(submittedStageCommands.size ? { submittedStageCommands: [...submittedStageCommands] } : {}) })
  collectTerminalSubmissions(scope)
}
function recoveryKey(scope: string, instanceId: string, id: string) {
  return key('ui', `recovery:${JSON.stringify([scope, instanceId, id])}`)
}
/** Retain and verify a separate immutable copy BEFORE reading/replacing the editor base. */
export function retainConflictRecovery(scope: string, edit: NextDraftEdit): ConflictRecovery {
  assertScope(scope, edit.graph.workspaceId, edit.graph.id)
  const snapshot = SnapshotSchema.parse({ context: { ...edit.context, agents: referencedAgents(edit) },
    graph: edit.graph, agentEdits: edit.agentEdits, agentForms: edit.agentForms,
    workflowForms: edit.workflowForms, remoteEditIntent: edit.remoteEditIntent })
  const recovery = ConflictRecoverySchema.parse({ id: crypto.randomUUID(), originalInstanceId: edit.instanceId,
    recordedAt: new Date().toISOString(), snapshot })
  const name = recoveryKey(scope, edit.instanceId, recovery.id)
  if (storage().getItem(name) !== null) throw new Error('This recovery already exists. No retained draft was replaced.')
  write(name, recovery)
  const confirmed = read(name, ConflictRecoverySchema)
  if (!confirmed) throw new Error(storageFailure)
  return confirmed
}
export function readConflictRecoveries(scope: string): ConflictRecovery[] {
  const local = storage(), start = key('ui', 'recovery:')
  const names = Array.from({ length: local.length }, (_, index) => local.key(index))
  const values: ConflictRecovery[] = []
  for (const name of names) {
    if (!name?.startsWith(start)) continue
    const value = read(name, ConflictRecoverySchema)
    if (!value || nextDraftKey(value.snapshot.graph.workspaceId, value.snapshot.graph.id) !== scope) continue
    assertScope(scope, value.snapshot.context.draft.workspaceId, value.snapshot.context.draft.workflowId)
    if (name !== recoveryKey(scope, value.originalInstanceId, value.id)) throw new Error('The recovered draft identity is invalid. It has been retained.')
    values.push(value)
  }
  return values.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))
}
/** Only an explicit selected-recovery discard removes this copy; Save never collects it. */
export function discardConflictRecovery(scope: string, selected: ConflictRecovery): void {
  const name = recoveryKey(scope, selected.originalInstanceId, selected.id)
  const existing = read(name, ConflictRecoverySchema)
  if (!existing) return
  assertScope(scope, existing.snapshot.graph.workspaceId, existing.snapshot.graph.id)
  storage().removeItem(name)
  if (storage().getItem(name) !== null) throw new Error(storageFailure)
}
export function readEditOutbox(scope: string): EditIntentOutbox | undefined {
  const value = read(key('outbox', scope), OutboxSchema)
  if (value) {
    assertScope(scope, value.request.workspaceId, value.request.workflowId)
    assertScope(scope, value.target.workspaceId, value.target.id)
  }
  return value
}
/** Command payloads remain immutable until terminal readback and all retained consumers settle. */
function submissionKey(scope: string, commandId: string) { return key('ui', `submission:${JSON.stringify([scope, commandId])}`) }
function retainEditSubmission(scope: string, candidate: EditIntentOutbox): EditIntentOutbox {
  const value = OutboxSchema.parse(candidate)
  assertScope(scope, value.request.workspaceId, value.request.workflowId)
  assertScope(scope, value.target.workspaceId, value.target.id)
  const name = submissionKey(scope, value.request.commandId)
  const previousRecord = read(name, SubmissionSchema)
  const previous = previousRecord ? submissionPayload(previousRecord) : undefined
  if (previous && !sameWorkflowValue(previous, value)) throw new Error('The retained submission conflicts with this exact command. No evidence was replaced.')
  if (!previous) write(name, value)
  return previous ?? value
}
function submissionPayload(record: z.infer<typeof SubmissionSchema>): EditIntentOutbox {
  return { request: record.request, target: record.target,
    ...(record.agentTarget ? { agentTarget: record.agentTarget } : {}) }
}
function retainedSnapshots(scope: string) {
  const local = storage()
  const names = Array.from({ length: local.length }, (_, index) => local.key(index))
  const start = key('draft', `${scope}:`)
  return names.flatMap(name => {
    if (!name?.startsWith(start)) return []
    const snapshot = read(name, SnapshotSchema)
    return snapshot ? [{ name, snapshot }] : []
  })
}
function removeSubmission(scope: string, commandId: string, snapshots: ReturnType<typeof retainedSnapshots>) {
  for (const { name, snapshot } of snapshots) {
    if (!snapshot.submittedStageCommands?.includes(commandId) && !snapshot.acknowledgedStageCommands?.includes(commandId)) continue
    write(name, { ...snapshot,
      submittedStageCommands: snapshot.submittedStageCommands?.filter(id => id !== commandId),
      acknowledgedStageCommands: snapshot.acknowledgedStageCommands?.filter(id => id !== commandId) })
  }
  storage().removeItem(submissionKey(scope, commandId))
}
/** A suspended form keeps its submitted payload even after another tab acknowledges it. */
function collectTerminalSubmissions(scope: string, incomingCommandId?: string) {
  const local = storage()
  const names = Array.from({ length: local.length }, (_, index) => local.key(index))
  const start = key('ui', 'submission:')
  let snapshots: ReturnType<typeof retainedSnapshots>
  try { snapshots = retainedSnapshots(scope) }
  catch { return /* ignore: corrupt sibling forms prevent safe collection. */ }
  const active = readEditOutbox(scope)?.request.commandId
  const completed = names.flatMap(name => {
    if (!name?.startsWith(start)) return []
    const record = read(name, SubmissionSchema)
    return record?.terminal && nextDraftKey(record.request.workspaceId, record.request.workflowId) === scope ? [record] : []
  })
  const latest = completed.at(-1)?.request.commandId
  for (const record of completed) {
    const commandId = record.request.commandId
    if (active === commandId) continue
    // Keep one recent payload for immediate duplicate/conflicting-command detection.
    if (commandId === latest && (!incomingCommandId || incomingCommandId === commandId)) continue
    const replacements = completed.slice(completed.indexOf(record) + 1).filter(other =>
      sameStageRequest(record.request, other.request) && sameWorkflowValue(record.target, other.target)
      && sameWorkflowValue(record.agentTarget, other.agentTarget))
    const needed = snapshots.some(({ snapshot }) => {
      if (snapshot.acknowledgedStageCommands?.includes(commandId)) return false
      if (!snapshot.submittedStageCommands?.includes(commandId) && !snapshotMatchesSubmission(snapshot, record)) return false
      return !replacements.some(other => snapshot.submittedStageCommands?.includes(other.request.commandId)
        || snapshot.acknowledgedStageCommands?.includes(other.request.commandId))
    })
    if (!needed) {
      removeSubmission(scope, commandId, snapshots)
      snapshots = retainedSnapshots(scope)
    }
  }
}
/** Call only after authenticated terminal readback has been reconciled with the local form. */
export function acknowledgeEditSubmission(scope: string, intent: GraphEditIntentV3) {
  if (!['saved', 'discarded'].includes(intent.state)) return
  const name = submissionKey(scope, intent.stageCommandId)
  const record = read(name, SubmissionSchema)
  if (!record || !matchesEditIntent(record, intent)) return
  if (!record.terminal) write(name, { ...record, terminal: true })
  collectTerminalSubmissions(scope)
}

function snapshotMatchesSubmission(snapshot: z.infer<typeof SnapshotSchema>, value: EditIntentOutbox): boolean {
  const request = value.request, draft = snapshot.context.draft
  return draft.workspaceId === request.workspaceId && draft.workflowId === request.workflowId && draft.id === request.draftId
    && draft.publishedRevision === request.expectedRevision && draft.baseWorkflowVersionId === request.expectedWorkflowVersionId
    && sameAuthoredWorkflow(snapshot.graph, value.target)
    && sameWorkflowValue(snapshot.agentEdits ?? {}, value.agentTarget ?? {})
}
/** Capture only tabs whose local form still matches this Stage at reservation time.
 * Later typing keeps that lineage; already-divergent tabs remain pinned to their
 * own revision and must hit the server conflict/reload path explicitly. */
function markSubmittedSnapshots(scope: string, value: EditIntentOutbox): void {
  const local = storage(), ownName = key('draft', `${scope}:${tab()}`)
  const mark = (name: string, snapshot: z.infer<typeof SnapshotSchema>) => {
    if (!snapshotMatchesSubmission(snapshot, value)) return
    const submittedStageCommands = new Set(snapshot.submittedStageCommands)
    submittedStageCommands.add(value.request.commandId)
    write(name, { ...snapshot, submittedStageCommands: [...submittedStageCommands] })
  }
  const own = read(ownName, SnapshotSchema)
  if (own) mark(ownName, own)
  const start = key('draft', `${scope}:`)
  for (let i = 0; i < local.length; i++) {
    const name = local.key(i)
    if (!name?.startsWith(start) || name === ownName) continue
    try {
      const snapshot = read(name, SnapshotSchema)
      if (snapshot) mark(name, snapshot)
    } catch {
      // ignore: an unreadable sibling gets no submission marker and cannot advance another form.
    }
  }
}
export function matchesEditIntent(value: EditIntentOutbox, intent: GraphEditIntentV3): boolean {
  const request = value.request
  return request.workspaceId === intent.workspaceId && request.workflowId === intent.workflowId
    && value.target.workspaceId === intent.workspaceId && value.target.id === intent.workflowId
    && request.commandId === intent.stageCommandId && request.draftId === intent.draftId
    && request.expectedRevision === intent.expectedRevision && request.expectedWorkflowVersionId === intent.expectedWorkflowVersionId
}
/** Call only with authenticated, scope-checked readback. Local evidence supplies
 * the submitted form, never the terminal state, result, or authority. */
export function readEditSubmission(scope: string, intent: GraphEditIntentV3): EditIntentOutbox | undefined {
  assertScope(scope, intent.workspaceId, intent.workflowId)
  const record = read(submissionKey(scope, intent.stageCommandId), SubmissionSchema)
  const value = record ? submissionPayload(record) : undefined
  if (value) {
    if (!matchesEditIntent(value, intent)) throw new Error('The retained submission does not match the acknowledged command and draft base.')
    return value
  }
  const outbox = readEditOutbox(scope)
  // Upgrade older reservations before ANY tab can consume the sole copy.
  return outbox && matchesEditIntent(outbox, intent) ? retainEditSubmission(scope, outbox) : undefined
}
/** Call only while withEditIntentLock holds the same principal-epoch/scope lock. */
export function reserveEditOutbox(scope: string, candidate: EditIntentOutbox): EditIntentOutbox {
  const existing = readEditOutbox(scope)
  if (existing) return retainEditSubmission(scope, existing) // Never replace an uncertain command with newer typing.
  collectTerminalSubmissions(scope, candidate.request.commandId)
  const value = retainEditSubmission(scope, candidate)
  markSubmittedSnapshots(scope, value)
  write(key('outbox', scope), value)
  return value
}
function removeEditOutbox(scope: string, stageCommandId: string): void {
  const existing = readEditOutbox(scope)
  if (!existing) return
  if (existing.request.commandId !== stageCommandId) throw new Error('Another edit command is retained. Its outbox was not cleared.')
  const local = storage(); local.removeItem(key('outbox', scope))
  if (local.getItem(key('outbox', scope)) !== null) throw new Error(storageFailure)
}
/** Acknowledgement must be from authenticated, scope-checked persisted readback. */
export function acknowledgeEditOutbox(scope: string, stageCommandId: string): void {
  const existing = readEditOutbox(scope)
  if (existing?.request.commandId === stageCommandId) retainEditSubmission(scope, existing)
  removeEditOutbox(scope, stageCommandId)
  collectTerminalSubmissions(scope)
}
/** These Stage errors originate only before intent insertion (prepare/perform),
 * not in the post-commit readback. Do NOT generalize to all 4xx: authorization,
 * receipt conflicts and unavailable readback can follow a committed Stage. */
export function isDefinitiveStageRejection(error: unknown): boolean {
  if (!ApiError.is(error)) return false
  if (error.status === 404) return error.code === 'GRAPH_DRAFT_NOT_FOUND'
  return error.status === 409 && ['REVISION_CONFLICT', 'WORKFLOW_BASE_CONFLICT', 'GRAPH_INVALID',
    'AGENT_ID_CONFLICT', 'AGENT_REVISION_CONFLICT', 'AGENT_SOURCE_CONFLICT', 'GRAPH_EDIT_INTENT_EXISTS',
    'WORKTREE_BINDING_REQUIRED', 'WORKTREE_COMPUTER_CONFLICT',
    'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED'].includes(error.code)
}
/** Call only for the exact editStage failure, under the same session/scope lock.
 * Releasing a rejected reservation never discards or rewrites the local form. */
export function rejectEditOutbox(scope: string, request: GraphEditStageInputV3, error: unknown): boolean {
  if (!isDefinitiveStageRejection(error)) return false
  const existing = readEditOutbox(scope)
  if (!existing) return false
  if (!sameWorkflowValue(existing.request, request)) throw new Error('Another edit command is retained. Its outbox was not cleared.')
  removeEditOutbox(scope, request.commandId)
  removeSubmission(scope, request.commandId, retainedSnapshots(scope))
  return true
}
export function sameStageRequest(left: GraphEditStageInputV3, right: GraphEditStageInputV3) {
  return sameWorkflowValue({ ...left, commandId: null }, { ...right, commandId: null })
}
export async function withEditIntentLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const generation = sessionGeneration(), name = key('outbox', scope)
  storage() // Fail before any request when durable reservation is unavailable.
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely reserve a cross-tab edit command. No Stop or save was sent.')
  return navigator.locks.request(name, async () => { assertSession(generation); return work() })
}
export function clearEditIntentStorage() {
  if (typeof window === 'undefined') return
  releaseTabOwnership()
  for (const kind of ['draft', 'outbox', 'ui'] as const) {
    const start = key(kind, '')
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const name = window.localStorage.key(i)
        if (name?.startsWith(start)) window.localStorage.removeItem(name)
      }
    } catch {
      // ignore: session rotation also makes old protected keys inaccessible.
    }
  }
}
