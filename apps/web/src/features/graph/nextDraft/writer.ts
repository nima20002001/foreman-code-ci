import { errorMessage } from '../../../shared/errorMessage'
import { acknowledgeAgentEdits, hasAgentEdits } from './agentEdits'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { draftOperations, hasLocalChanges, mergeAcknowledgement, type AuthoringIssue } from './model'
import type { DraftFailure, DraftRequest, NextDraftEdit } from './state'
import type { NextDraftApi } from './transport'

export type DraftAccess = {
  get: (key: string) => NextDraftEdit | undefined
  update: (key: string, change: (edit: NextDraftEdit) => NextDraftEdit) => void
}
export type WriteResult = { published: boolean; newerLocalEdits: boolean }

function issuesFrom(value: unknown): AuthoringIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('message' in item) || typeof item.message !== 'string') return []
    return [{ code: 'code' in item && typeof item.code === 'string' ? item.code : 'INVALID_INPUT', message: item.message }]
  })
}

export function draftFailure(error: unknown, commandMayHaveRun: boolean): DraftFailure {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const status = typeof value.status === 'number' ? value.status : 0
  const code = typeof value.code === 'string' ? value.code : 'REQUEST_FAILED'
  const details = value.details && typeof value.details === 'object' ? value.details as Record<string, unknown> : {}
  const issues = issuesFrom(details.issues ?? value.issues)
  // A transport/parse failure cannot prove that a mutation was not committed.
  const uncertain = commandMayHaveRun && (status === 0 || status >= 500 || code === 'INVALID_RESPONSE')
  return { code, uncertain, message: errorMessage(error, 'The request failed.'), ...(issues.length ? { issues } : {}) }
}

/** One serial authoring owner per draft key, including remounts and ambiguous retries. */
export function createNextDraftWriter(
  api: NextDraftApi,
  access: DraftAccess,
  validateSubmission: (graph: WorkflowDefinitionV3, operations: unknown[]) => void,
  commandId: () => string = () => crypto.randomUUID(),
  captureSession: () => () => void = () => () => undefined,
) {
  const running = new Map<string, { instanceId: string; promise: Promise<WriteResult> }>()
  return {
    write(key: string, publish: boolean): Promise<WriteResult> {
      const initial = access.get(key)
      if (!initial) return Promise.reject(new Error('The editor draft is no longer available.'))
      const instanceId = initial.instanceId
      const existing = running.get(key)
      if (existing?.instanceId === instanceId) return existing.promise
      const assertSession = captureSession()
      const current = () => {
        assertSession()
        const edit = access.get(key)
        if (!edit || edit.instanceId !== instanceId) throw new Error('The editor session changed; the previous response was not applied.')
        return edit
      }
      const update = (change: (edit: NextDraftEdit) => NextDraftEdit) => {
        assertSession()
        access.update(key, (edit) => edit.instanceId === instanceId ? change(edit) : edit)
      }
      try {
        if (!initial.pending) {
          const operations = draftOperations(initial.context, initial.graph, initial.agentEdits)
          validateSubmission(initial.graph, operations)
          update((edit) => ({ ...edit, busy: true, error: undefined, validation: undefined,
            plan: { target: initial.graph, operations, publish, agentTarget: initial.agentEdits } }))
        } else {
          // Retry means reconcile the old intent, not submit newer edits under its command ID.
          if (!initial.plan) throw new Error('The unresolved command has no retained submission. Do not start a replacement write.')
          update((edit) => ({ ...edit, busy: true, error: undefined }))
        }
      } catch (error) {
        const failure = draftFailure(error, false)
        access.update(key, (edit) => edit.instanceId === instanceId ? { ...edit, busy: false, error: failure } : edit)
        return Promise.reject(error)
      }
      const execute = async (): Promise<WriteResult> => {
        let published = false
        try {
          for (;;) {
            const edit = current(), plan = edit.plan
            if (!plan) break
            let request = edit.pending
            if (!request) {
              if (!plan.operations.length && !plan.publish) {
                update((state) => ({ ...state, plan: undefined }))
                break
              }
              const base = edit.context.draft
              const scope = { commandId: commandId(), workspaceId: base.workspaceId, workflowId: base.workflowId,
                draftId: base.id, expectedRevision: base.revision, executionSemanticsVersion: 3 as const }
              request = plan.operations.length
                ? { kind: 'apply', ...scope, operations: plan.operations.slice(0, 100) }
                : { kind: 'save', ...scope }
              update((state) => ({ ...state, pending: request }))
            }
            const sent: DraftRequest = request
            // The final apply batch acknowledges the complete local target graph.
            const final = sent.kind === 'apply' && plan.operations.length <= sent.operations!.length
            const result = await api.write(sent, final ? plan.target : undefined)
            current()
            update((state) => {
              if (state.pending?.commandId !== sent.commandId || !state.plan) return state
              if (result.draft.id !== sent.draftId || result.draft.workspaceId !== sent.workspaceId
                || result.draft.workflowId !== sent.workflowId || (sent.kind === 'apply' ? result.draft.revision !== sent.expectedRevision + 1
                  : result.draft.publishedRevision !== result.draft.revision)) throw new Error('A command returned an unexpected draft identity or revision.')
              const remaining = sent.kind === 'apply' ? state.plan.operations.slice(sent.operations!.length) : []
              const catalog = new Map(state.context.agents.map((record) => [record.agent.id, record]))
              for (const record of result.agents ?? []) catalog.set(record.agent.id, record)
              const complete = sent.kind === 'save' || remaining.length === 0
              return { ...state, context: { draft: result.draft, savedDraft: sent.kind === 'save' ? result.draft : state.context.savedDraft ?? state.context.draft, agents: result.agents ? [...catalog.values()] : state.context.agents },
                // Intermediate batches are not the whole submitted document. Never replace unapplied edits with them.
                graph: complete ? mergeAcknowledgement(state.graph, state.plan.target, result.draft.graph) : state.graph,
                agentEdits: complete ? acknowledgeAgentEdits(state.agentEdits, state.plan.agentTarget, {
                  draft: result.draft, agents: [...catalog.values()],
                }) : state.agentEdits,
                pending: undefined, error: undefined,
                plan: sent.kind === 'save' ? undefined : { ...state.plan, operations: remaining } }
            })
            if (sent.kind === 'save') published = true
          }
          // A validation read is advisory and revision-scoped. Save always validates again transactionally.
          if (!published) {
            const before = current().context.draft
            const validation = await api.validate(before.workspaceId, before.workflowId, before.id)
            const readback = await api.get(before.workspaceId, before.workflowId, before.id)
            if (readback.revision !== before.revision) {
              update((edit) => ({ ...edit, error: { code: 'REVISION_CONFLICT', uncertain: false,
                message: 'The shared draft changed during validation. Your local edits are retained; reload explicitly before continuing.' } }))
            } else update((edit) => edit.context.draft.revision !== before.revision || hasLocalChanges(edit.context, edit.graph) || hasAgentEdits(edit) ? edit : {
              ...edit, validation: { revision: before.revision, valid: validation.valid, issues: validation.issues },
            })
          }
          const done = current()
          update((edit) => ({ ...edit, busy: false }))
          return { published, newerLocalEdits: hasLocalChanges(done.context, done.graph) || hasAgentEdits(done) }
        } catch (error) {
          const edit = access.get(key)
          if (edit?.instanceId === instanceId) {
            const failure = draftFailure(error, !!edit.pending)
            access.update(key, (state) => state.instanceId !== instanceId ? state : { ...state, busy: false, error: failure,
              // Definitive rejection is not a successful save, and is not an ambiguous command.
              pending: failure.uncertain ? state.pending : undefined, plan: failure.uncertain ? state.plan : undefined })
          }
          throw error
        }
      }
      // Defer execution one microtask so even synchronous/mock transports share the same owner.
      const promise = Promise.resolve().then(execute).finally(() => { if (running.get(key)?.promise === promise) running.delete(key) })
      running.set(key, { instanceId, promise })
      return promise
    },
  }
}
