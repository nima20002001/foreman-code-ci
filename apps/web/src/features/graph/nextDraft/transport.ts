import { AgentMutationResultSchema, StagedAgentSchema, type GraphValidationResultSchema, type AgentCreateInputSchema, type AgentUpdateInput } from '@foreman-code/contracts/management'
import { SupportedHarnessConfigurationSchema } from '@foreman-code/contracts'
import {
  GraphEditReadResultV3Schema, GraphEditReadInputV3Schema, GraphEditStageInputV3Schema, GraphEditAdvanceInputV3Schema, GraphEditDiscardInputV3Schema,
  type GraphEditReadInputV3, type GraphEditStageInputV3, type GraphEditAdvanceInputV3, type GraphEditDiscardInputV3, type GraphEditReadResultV3,
  GraphDraftV3Schema, WorkflowDefinitionV3Schema, CurrentManagedWorkflowSchema, CurrentWorkflowReadResultSchema,
  CurrentWorkflowSaveResultSchema, CurrentWorkflowValidationSchema, CURRENT_WORKFLOW_ROUTES,
  GraphDraftOperationV3Schema, CurrentRunPageSchema, sameAuthoredWorkflow, sameExecutableWorkflow,
  preserveWorkflowGeometry, preserveWorkflowPresentation,
  type GraphDraftOperationV3, type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../../shared/api/client'
import type { z } from 'zod'
import type { DraftRequest } from './state'
import type { NextDraftContext } from './model'
import { coalesceAgentEdits } from './agentEdits'

export type CurrentDraft = z.infer<typeof GraphDraftV3Schema>
export type AuthoringContext = NextDraftContext
const part = encodeURIComponent
const workflowPath = (workspaceId: string, workflowId: string) =>
  `/api/management/workspaces/${part(workspaceId)}/workflows/${part(workflowId)}`
const route = (template: string, workspaceId: string, workflowId: string) =>
  template.replace(':workspaceId', part(workspaceId)).replace(':workflowId', part(workflowId))
const draftIdFor = (workflowId: string) => `board-${workflowId}`

function assertScope(draft: CurrentDraft, workspaceId: string, workflowId: string, draftId?: string) {
  if (draft.workspaceId !== workspaceId || draft.workflowId !== workflowId || draft.graph.workspaceId !== workspaceId
    || draft.graph.id !== workflowId || (draftId !== undefined && draft.id !== draftId)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The draft response has a different workspace, workflow or draft identity.' })
}

function assertIntentScope(value: GraphEditReadResultV3, input: { workspaceId: string; workflowId: string; intentId?: string }) {
  const intent = value.intent
  if (intent && (intent.workspaceId !== input.workspaceId || intent.workflowId !== input.workflowId
    || (input.intentId !== undefined && intent.id !== input.intentId))) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The private edit intent returned a different scope or identity.' })
  }
  return value
}

/** The Board's draft is local. Its revision counts local acknowledgements; the
 * saved workflow revision and version it was opened from are retained as the
 * optimistic-concurrency pins for the shared current definition writer. */
type Opened = { draft: CurrentDraft; savedDraft: CurrentDraft; savedRevision: number }

/** Uses the existing session-generation-fenced, same-origin HTTP boundary. No bearer fallback. */
export function createNextDraftApi(client: ApiClient = apiClient) {
  const opened = new Map<string, Opened>()
  const key = (workspaceId: string, workflowId: string) => JSON.stringify([workspaceId, workflowId])

  const load = async (workspaceId: string, workflowId: string, options?: RequestOptions): Promise<Opened> => {
    const workflow = await client.request(workflowPath(workspaceId, workflowId), CurrentManagedWorkflowSchema, options)
    const saved = workflow.currentVersionId ? await client.request(route(CURRENT_WORKFLOW_ROUTES.saved, workspaceId, workflowId),
      CurrentWorkflowReadResultSchema, options) : undefined
    if (saved && (saved.currentVersionId !== workflow.currentVersionId || saved.revision !== workflow.revision)) {
      throw new ApiError({ code: 'GRAPH_CHANGING', message: 'The saved workflow changed while loading. Retry after the current edit.' }, 409)
    }
    if (saved && (workflow.workflow.version !== saved.version.version
      || workflow.workflow.createdAt !== saved.version.definition.createdAt
      || !sameExecutableWorkflow({ ...workflow.workflow, name: saved.version.definition.name,
        description: saved.version.definition.description }, saved.version.definition))) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The current workflow differs from its saved execution definition.' })
    }
    const draft = GraphDraftV3Schema.parse({
      id: draftIdFor(workflowId), workspaceId, workflowId, revision: workflow.revision, publishedRevision: workflow.revision,
      baseWorkflowVersionId: workflow.currentVersionId ?? null,
      graph: saved ? preserveWorkflowPresentation({ ...saved.version.definition, name: workflow.workflow.name,
        description: workflow.workflow.description }, workflow.workflow) : workflow.workflow, stagedAgents: [],
      updatedByPrincipalId: 'board', updatedAt: new Date().toISOString(),
    })
    assertScope(draft, workspaceId, workflowId)
    return { draft, savedDraft: draft, savedRevision: workflow.revision }
  }
  const open = async (workspaceId: string, workflowId: string, options?: RequestOptions) => {
    const current = opened.get(key(workspaceId, workflowId))
    if (current && current.draft.revision !== current.draft.publishedRevision) return current.draft
    const value = await load(workspaceId, workflowId, options)
    opened.set(key(workspaceId, workflowId), value)
    return value.draft
  }
  const get = async (workspaceId: string, workflowId: string, draftId: string, options?: RequestOptions) => {
    const draft = await open(workspaceId, workflowId, options)
    assertScope(draft, workspaceId, workflowId, draftId)
    return draft
  }
  const expectedPins = async (workspaceId: string, graph: WorkflowDefinitionV3, stagedAgents: z.infer<typeof StagedAgentSchema>[] = [], displayedAgents?: NextDraftContext['agents']) => {
    const agents = await client.listManagedAgents(workspaceId)
    const configurations: Record<string, string> = {}
    for (const node of graph.nodes) {
      if(node.kind==='job')continue
      const staged = stagedAgents.find((item) => item.agent.id === node.agentId)
      if (staged?.baseRevision === null) continue
      const agent = staged?.agent ?? (displayedAgents ?? agents.items).find((item) => item.agent.id === node.agentId)?.agent
      if (!agent?.configurationVersionId) throw new ApiError({ code: 'AGENT_NOT_FOUND', message: 'A board Agent has no saved configuration. Reload before saving.' }, 409)
      configurations[node.agentId] = agent.configurationVersionId
    }
    return { expectedAgentConfigurationVersionIds: configurations, agents: agents.items }
  }
  /** Agent operations use the shared Agent service; graph operations stay local. */
  const applyAgents = createDraftAgentWriter(client)
  return {
    open, get,
    discardLocal(workspaceId: string, workflowId: string) {
      const entry = opened.get(key(workspaceId, workflowId))
      if (entry) opened.set(key(workspaceId, workflowId), { ...entry, draft: entry.savedDraft })
    },
    /** Fresh persisted presentation and immutable pins, without changing local authoring state. */
    async layoutBase(workspaceId: string, workflowId: string) {
      const current = await load(workspaceId, workflowId)
      const saved = await client.request(route(CURRENT_WORKFLOW_ROUTES.saved, workspaceId, workflowId), CurrentWorkflowReadResultSchema)
      if (current.draft.revision !== saved.revision || current.draft.baseWorkflowVersionId !== saved.currentVersionId) {
        throw new ApiError({ code: 'REVISION_CONFLICT', message: 'The saved workflow changed while reading positions.' }, 409)
      }
      return { draft: current.draft, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds }
    },
    /** Agent configuration references for a complete-definition command. */
    pins: (workspaceId: string, graph: WorkflowDefinitionV3, stagedAgents?: z.infer<typeof StagedAgentSchema>[], displayedAgents?: NextDraftContext['agents']) =>
      expectedPins(workspaceId, graph, stagedAgents, displayedAgents),
    async editRead(raw: GraphEditReadInputV3, options?: RequestOptions) {
      const input = GraphEditReadInputV3Schema.parse(raw)
      const query = new URLSearchParams({ ...(input.draftId ? { draftId: input.draftId } : {}), ...(input.intentId ? { intentId: input.intentId } : {}) })
      return assertIntentScope(await client.request(`${route(CURRENT_WORKFLOW_ROUTES.edits, input.workspaceId, input.workflowId)}?${query}`,
        GraphEditReadResultV3Schema, options), input)
    },
    async editStage(raw: GraphEditStageInputV3) {
      const input = GraphEditStageInputV3Schema.parse(raw)
      return assertIntentScope(await client.request(route(CURRENT_WORKFLOW_ROUTES.edits, input.workspaceId, input.workflowId),
        GraphEditReadResultV3Schema, { method: 'POST', body: input }), input)
    },
    async editAdvance(raw: GraphEditAdvanceInputV3) {
      const input = GraphEditAdvanceInputV3Schema.parse(raw)
      return assertIntentScope(await client.request(route(CURRENT_WORKFLOW_ROUTES.edits, input.workspaceId, input.workflowId),
        GraphEditReadResultV3Schema, { method: 'POST', body: input }), input)
    },
    async editDiscard(raw: GraphEditDiscardInputV3) {
      const input = GraphEditDiscardInputV3Schema.parse(raw)
      return assertIntentScope(await client.request(route(CURRENT_WORKFLOW_ROUTES.edits, input.workspaceId, input.workflowId),
        GraphEditReadResultV3Schema, { method: 'POST', body: input }), input)
    },
    async context(workspaceId: string, workflowId: string, options?: RequestOptions, reload = false): Promise<AuthoringContext> {
      for (let attempt = 0; attempt < 3; ++attempt) {
        const before = await load(workspaceId, workflowId, options)
        const agents = await client.listManagedAgents(workspaceId, options)
        const after = await load(workspaceId, workflowId, options)
        if (before.savedRevision === after.savedRevision
          && sameAuthoredWorkflow(before.savedDraft.graph, after.savedDraft.graph)) {
          // Keep local acknowledgements while refreshing independently saved geometry.
          const current = opened.get(key(workspaceId, workflowId))
          if (!reload && current && current.savedRevision === after.savedRevision
            && current.draft.baseWorkflowVersionId === after.draft.baseWorkflowVersionId
            && sameAuthoredWorkflow(current.savedDraft.graph, after.savedDraft.graph)) {
            const refreshed = { ...current,
              draft: { ...current.draft, graph: preserveWorkflowGeometry(current.draft.graph, after.draft.graph) },
              savedDraft: { ...current.savedDraft,
                graph: preserveWorkflowGeometry(current.savedDraft.graph, after.savedDraft.graph) },
            }
            opened.set(key(workspaceId, workflowId), refreshed)
            return { draft: refreshed.draft, savedDraft: refreshed.savedDraft, agents: agents.items }
          }
          opened.set(key(workspaceId, workflowId), after)
          return { draft: after.draft, savedDraft: after.savedDraft, agents: agents.items }
        }
      }
      throw new ApiError({ code: 'GRAPH_CHANGING', message: 'The saved workflow changed while loading. Retry after the current edit.' }, 409)
    },
    /** `target` is the complete local graph once this is the final batch of a plan. */
    async write(request: DraftRequest, target?: WorkflowDefinitionV3) {
      const entry = opened.get(key(request.workspaceId, request.workflowId))
      if (!entry || entry.draft.id !== request.draftId || entry.draft.revision !== request.expectedRevision) {
        throw new ApiError({ code: 'REVISION_CONFLICT', message: 'The board draft changed. Reload before continuing.' }, 409)
      }
      const base = entry.draft
      if (request.kind === 'apply') {
        const agents = await applyAgents(request.workspaceId, request.operations ?? [], request.commandId)
        const draft = GraphDraftV3Schema.parse({ ...base, revision: base.revision + 1, graph: target ?? base.graph,
          updatedAt: new Date().toISOString() })
        opened.set(key(request.workspaceId, request.workflowId), { ...entry, draft })
        return { draft, agents }
      }
      const pins = await expectedPins(request.workspaceId, base.graph)
      const result = await client.request(route(CURRENT_WORKFLOW_ROUTES.saved, request.workspaceId, request.workflowId),
        CurrentWorkflowSaveResultSchema, { method: 'PUT', body: {
          commandId: request.commandId, executionSemanticsVersion: 3, expectedRevision: entry.savedRevision,
          expectedWorkflowVersionId: base.baseWorkflowVersionId, expectedAgentConfigurationVersionIds: pins.expectedAgentConfigurationVersionIds,
          graph: base.graph } })
      const saved = result.value
      if (saved.workspaceId !== request.workspaceId || saved.workflowId !== request.workflowId
        || !sameAuthoredWorkflow(saved.presentation ?? saved.version.definition, base.graph)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The publication acknowledgement is missing its immutable version pin.' })
      }
      // Published drafts carry the saved workflow revision, the pin later
      // edit intents and Start use. Local apply counts restart from it.
      const draft = GraphDraftV3Schema.parse({ ...base, revision: saved.revision, publishedRevision: saved.revision, baseWorkflowVersionId: saved.currentVersionId,
        graph: saved.presentation ?? saved.version.definition, updatedAt: new Date().toISOString() })
      opened.set(key(request.workspaceId, request.workflowId), { draft, savedDraft: draft, savedRevision: saved.revision })
      return { draft, agents: pins.agents, version: saved.version }
    },
    async validate(workspaceId: string, workflowId: string, draftId: string): Promise<z.infer<typeof GraphValidationResultSchema>> {
      const entry = opened.get(key(workspaceId, workflowId))
      if (!entry || entry.draft.id !== draftId) throw new ApiError({ code: 'REVISION_CONFLICT', message: 'Reload the board before validating.' }, 409)
      try {
        const pins = await expectedPins(workspaceId, entry.draft.graph)
        await client.request(route(CURRENT_WORKFLOW_ROUTES.validate, workspaceId, workflowId), CurrentWorkflowValidationSchema, { method: 'POST', body: {
          executionSemanticsVersion: 3, expectedRevision: entry.savedRevision, expectedWorkflowVersionId: entry.draft.baseWorkflowVersionId,
          expectedAgentConfigurationVersionIds: pins.expectedAgentConfigurationVersionIds,
          graph: entry.draft.graph } })
        return { valid: true, issues: [] }
      } catch (error) {
        if (!ApiError.is(error) || (error.status ?? 0) >= 500 || !error.status) throw error
        const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {}
        const issues = Array.isArray(details.issues) ? details.issues.flatMap((item: unknown) => item && typeof item === 'object'
          && 'message' in item && typeof item.message === 'string' ? [{ code: 'code' in item && typeof item.code === 'string' ? item.code : error.code,
            message: item.message }] : []) : []
        return { valid: false, issues: issues.length ? issues : [{ code: error.code, message: error.message }] }
      }
    },
    runs: async (workspaceId: string, workflowId: string, cursor: string | null = null, options?: RequestOptions) => {
      const query = new URLSearchParams({ workflowId, limit: '20' })
      if (cursor) query.set('cursor', cursor)
      const result = await client.request(
        `/api/management/workspaces/${part(workspaceId)}/runs?${query}`,
        CurrentRunPageSchema, options)
      if (result.items.some((run) => run.workspaceId !== workspaceId || run.workflowId !== workflowId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Run list contains a different workflow scope.' })
      }
      return result
    },
  }
}
export const nextDraftApi = createNextDraftApi()
export type NextDraftApi = ReturnType<typeof createNextDraftApi>

/** Structural form errors are local. Executability, authorization and all native policy remain server-authoritative. */
export function assertDraftSubmission(graph: NextDraftContext['draft']['graph'], operations: unknown[]) {
  WorkflowDefinitionV3Schema.parse(graph)
  for (const operation of operations) GraphDraftOperationV3Schema.parse(operation)
}

function createDraftAgentWriter(client: ApiClient) {
  const pendingAgentCommands = new Map<string, {
    path: string; method: 'POST' | 'PATCH';
    body: Omit<z.input<typeof AgentCreateInputSchema>, 'workspaceId'> | Omit<AgentUpdateInput, 'workspaceId' | 'agentId'>;
  }>()
  const applyAgents = async (workspaceId: string, operations: readonly GraphDraftOperationV3[], commandId: string) => {
    const created = new Set<string>()
    const edits = coalesceAgentEdits(operations)
    const agentsPath = `/api/management/workspaces/${part(workspaceId)}/agents`
    let index = 0
    const catalog = async () => (await client.listManagedAgents(workspaceId)).items
    for (const operation of operations) {
      const command = `${commandId}:${index++}`
      if ((operation.type === 'agent.configure' || operation.type === 'agent.rename')
        && (created.has(operation.agentId) || edits.get(operation.agentId)!.index !== index - 1)) continue
      const pendingKey = JSON.stringify([workspaceId, command])
      const pending = pendingAgentCommands.get(pendingKey)
      if (pending) {
        // A lost response can follow a committed mutation. Reconcile its receipt
        // with the original pins before reading the now-changed catalog.
        await client.request(pending.path, AgentMutationResultSchema, { method: pending.method, body: pending.body })
        if (operation.type === 'agent.add') created.add(operation.agentId)
      } else if (operation.type === 'agent.add') {
        const configure = operations.find((item) => item.type === 'agent.configure' && item.agentId === operation.agentId)
        const content = configure?.type === 'agent.configure' ? {
          prompt: configure.prompt, assignedSkills: configure.assignedSkills,
          ...(configure.graphqlTools ? { graphqlTools: configure.graphqlTools } : {}),
          ...(configure.nativeTools ? { nativeTools: configure.nativeTools } : {}),
          ...(configure.description ? { description: configure.description } : {}), ...(configure.role ? { role: configure.role } : {}),
        } : { prompt: {}, assignedSkills: [] }
        const configuration = configure?.type === 'agent.configure' ? configure.configuration : operation.configuration
        const pending = structuredClone({ path: agentsPath, method: 'POST' as const, body: {
          commandId: command, agentId: operation.agentId, name: operation.name, productRole: operation.productRole,
          configuration: configuration ? SupportedHarnessConfigurationSchema.parse(configuration) : undefined, ...content } })
        pendingAgentCommands.set(pendingKey, pending)
        await client.request(pending.path, AgentMutationResultSchema, { method: pending.method, body: pending.body })
        created.add(operation.agentId)
      } else if ((operation.type === 'agent.configure' || operation.type === 'agent.rename') && !created.has(operation.agentId)) {
        const edit = edits.get(operation.agentId)!
        const agent = (await catalog()).find((item) => item.agent.id === operation.agentId)
        if (!agent?.agent.configurationVersionId) throw new ApiError({ code: 'AGENT_NOT_FOUND', message: 'The edited Agent is unavailable. Reload before saving.' }, 409)
        const body = {
          ...(edit.rename ? { name: edit.rename.name } : {}),
          ...(edit.configure ? { configuration: SupportedHarnessConfigurationSchema.parse(edit.configure.configuration), prompt: edit.configure.prompt,
            assignedSkills: edit.configure.assignedSkills, description: edit.configure.description ?? null,
            ...(edit.configure.graphqlTools ? { graphqlTools: edit.configure.graphqlTools } : {}),
            ...(edit.configure.nativeTools ? { nativeTools: edit.configure.nativeTools } : {}),
            role: edit.configure.role ?? null } : {}),
        }
        const pending = structuredClone({ path: `${agentsPath}/${part(operation.agentId)}`, method: 'PATCH' as const, body: {
          commandId: command, expectedRevision: operation.expectedAgentRevision,
          expectedConfigurationVersionId: agent.agent.configurationVersionId, ...body } })
        pendingAgentCommands.set(pendingKey, pending)
        await client.request(pending.path, AgentMutationResultSchema, { method: pending.method, body: pending.body })
      }
    }
    const agents = created.size || operations.some((item) => item.type === 'agent.configure' || item.type === 'agent.rename') ? await catalog() : undefined
    for (let index = 0; index < operations.length; index++) pendingAgentCommands.delete(JSON.stringify([workspaceId, `${commandId}:${index}`]))
    return agents
  }
  return applyAgents
}
