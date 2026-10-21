import { z } from 'zod'
import { StagedAgentSchema } from '../management/index.js'
import { GraphIdSchema } from './graphPrimitives.js'
import {
  CurrentJournalIdentitySchema, CurrentJournalReadInputSchema as GraphEditReadInputSchema,
  CurrentJournalAdvanceInputSchema as GraphEditAdvanceInputSchema,
  CurrentJournalDiscardInputSchema as GraphEditDiscardInputSchema, CurrentJournalRunStateSchema as GraphEditRunStateSchema,
} from './currentJournal.js'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowSavedSchema } from './currentAuthoring.js'
import { sameAuthoredWorkflow, sameExecutableWorkflow, sameWorkflowValue } from './meaningfulEdit.js'

/** Full current-v3 payload in the EXISTING private durable edit journal. No
 * selected Run or caller-provided Stop IDs. All graph forms use this one arm. */
export const CurrentEditStageInputSchema = CurrentWorkflowSaveInputSchema.extend({
  action: z.literal('stage_edits'), draftId: GraphIdSchema,
  stagedAgents: z.array(StagedAgentSchema).max(1000).optional(),
}).strict()
/** Private journal publication only. Ordinary workflow_save_v3 deliberately
 * rejects these Agent mutations and server-reserved resultant pins. */
export const CurrentEditSaveInputSchema = CurrentWorkflowSaveInputSchema.extend({
  stagedAgents: z.array(StagedAgentSchema).max(1000).optional(),
  resultantAgentConfigurationVersionIds: CurrentWorkflowSaveInputSchema.shape.expectedAgentConfigurationVersionIds.optional(),
}).strict()
export type CurrentEditSaveInput = z.infer<typeof CurrentEditSaveInputSchema>
export type CurrentEditStageInput = z.infer<typeof CurrentEditStageInputSchema>
export const CurrentEditReadInputSchema = GraphEditReadInputSchema
export const CurrentEditAdvanceInputSchema = GraphEditAdvanceInputSchema
export const CurrentEditDiscardInputSchema = GraphEditDiscardInputSchema
export const CurrentEditDraftSchema = z.object({
  id: GraphIdSchema, workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  revision: CurrentWorkflowSaveInputSchema.shape.expectedRevision,
  baseWorkflowVersionId: CurrentWorkflowSaveInputSchema.shape.expectedWorkflowVersionId,
  graph: CurrentWorkflowSaveInputSchema.shape.graph,
  presentationOnly: z.literal(true).optional(),
  agentConfigurationVersionIds: CurrentWorkflowSaveInputSchema.shape.expectedAgentConfigurationVersionIds,
  saveCommandId: GraphIdSchema.optional(),
  stagedAgents: CurrentEditSaveInputSchema.shape.stagedAgents,
  resultantAgentConfigurationVersionIds: CurrentEditSaveInputSchema.shape.resultantAgentConfigurationVersionIds,
}).strict()
export const CurrentEditIntentSchema = z.object({
  ...CurrentJournalIdentitySchema.shape,
  kind: z.literal('current'), stagedDraft: CurrentEditDraftSchema,
  saveInput: CurrentEditSaveInputSchema, result: CurrentWorkflowSavedSchema.optional(),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  const draft = value.stagedDraft, save = value.saveInput
  if (draft.id !== value.draftId || draft.workspaceId !== value.workspaceId || draft.workflowId !== value.workflowId
    || draft.graph.id !== value.workflowId || draft.graph.workspaceId !== value.workspaceId
    || draft.revision !== value.expectedRevision || value.savedWorkflowRevision !== value.expectedRevision
    || draft.baseWorkflowVersionId !== value.expectedWorkflowVersionId) fail('CURRENT_EDIT_BASE_CONFLICT')
  if (save.workspaceId !== value.workspaceId || save.workflowId !== value.workflowId
    || save.expectedRevision !== value.expectedRevision || save.expectedWorkflowVersionId !== value.expectedWorkflowVersionId
    || !sameWorkflowValue(save.graph, draft.graph)
    || !sameWorkflowValue(save.expectedAgentConfigurationVersionIds, draft.agentConfigurationVersionIds)
    || !sameWorkflowValue(save.stagedAgents, draft.stagedAgents)
    || !sameWorkflowValue(save.resultantAgentConfigurationVersionIds, draft.resultantAgentConfigurationVersionIds)) fail('CURRENT_EDIT_PAYLOAD_CONFLICT')
  const runs = new Set(value.affected.map((pin) => pin.runId))
  if (runs.size !== value.affected.length || value.affected.some((pin) => pin.workspaceId !== value.workspaceId
)) fail('CURRENT_EDIT_AFFECTED_SCOPE_CONFLICT')
  if (new Set(value.stops.map((stop) => stop.input.runId)).size !== value.stops.length
    || value.stops.some((stop) => stop.input.workspaceId !== value.workspaceId || !runs.has(stop.input.runId)
      || stop.receipt && stop.receipt.runId !== stop.input.runId)) fail('CURRENT_EDIT_STOP_SCOPE_CONFLICT')
  const agents = new Set(value.agentPins.map((pin) => pin.agentId))
  const updates = draft.stagedAgents ?? []
  if (updates.length && (draft.saveCommandId !== save.commandId || !draft.resultantAgentConfigurationVersionIds)) fail('CURRENT_EDIT_PAYLOAD_CONFLICT')
  const resultant = draft.resultantAgentConfigurationVersionIds ?? draft.agentConfigurationVersionIds
  if (draft.presentationOnly && (updates.length || value.affected.length || value.stops.length)) {
    fail('CURRENT_EDIT_PRESENTATION_SCOPE_CONFLICT')
  }
  if (value.result && updates.length && (value.result.agents?.length !== updates.length
    || new Set(value.result.agents?.map((item) => item.agent.id)).size !== updates.length
    || value.result.agents?.some((item) => {
      const original = updates.find((update) => update.agent.id === item.agent.id)
      return !original || item.agent.configurationVersionId !== resultant[item.agent.id]
        || item.agent.name !== original.agent.name || item.metadataRevision !== (original.baseRevision ?? 0) + 1
    }))) fail('CURRENT_EDIT_SAVED_AGENTS_CONFLICT')
  const nodeAgents = [...new Set(draft.graph.nodes.filter(node=>node.kind!=='job').map((node) => node.agentId))].sort()
  if (new Set(updates.map((item) => item.agent.id)).size !== updates.length
    || updates.some((item) => !nodeAgents.includes(item.agent.id)
      || (item.agent.configurationVersionId ?? null) !== (draft.agentConfigurationVersionIds[item.agent.id] ?? null))
    || !sameWorkflowValue(Object.keys(resultant).sort(), nodeAgents)
    || Object.entries(resultant).some(([id, pin]) => !updates.some((item) => item.agent.id === id) && pin !== draft.agentConfigurationVersionIds[id])
    || Object.keys(draft.agentConfigurationVersionIds).some((id) => !nodeAgents.includes(id))
    || agents.size !== value.agentPins.length || !sameWorkflowValue([...agents].sort(), nodeAgents)
    || value.agentPins.some((pin) => pin.configurationVersionId !== (draft.agentConfigurationVersionIds[pin.agentId] ?? null)
      || (pin.metadataRevision === null) !== (pin.configurationVersionId === null)
      || updates.some((item) => item.agent.id === pin.agentId && item.baseRevision !== pin.metadataRevision))) fail('CURRENT_EDIT_AGENT_PINS_CONFLICT')
  const commands = [value.stageCommandId, value.advanceCommandId, value.discardCommandId, save.commandId,
    ...value.stops.map((stop) => stop.input.commandId)]
  if (new Set(commands).size !== commands.length) fail('CURRENT_EDIT_COMMAND_ID_CONFLICT')
  if ((value.state === 'saved') !== !!value.result || value.state === 'saved' && !value.saveAttempted) fail('CURRENT_EDIT_RESULT_STATE_CONFLICT')
  const result = value.result
  const presentationSaved = draft.presentationOnly || !!result?.presentation
  const savedPinsValid = presentationSaved
    ? result?.revision === value.expectedRevision && result.currentVersionId === value.expectedWorkflowVersionId
      && !!result.presentation && sameAuthoredWorkflow(result.presentation, draft.graph)
    : result?.revision === value.expectedRevision + 1 && result.currentVersionId !== value.expectedWorkflowVersionId
  const executedGraph = presentationSaved && result
    ? { ...draft.graph, name: result.version.definition.name, description: result.version.definition.description }
    : draft.graph
  if (result && (result.workspaceId !== value.workspaceId || result.workflowId !== value.workflowId
    || !savedPinsValid
    || !sameExecutableWorkflow(result.version.definition, executedGraph)
    || !sameWorkflowValue(result.version.agentConfigurationVersionIds, resultant))) fail('CURRENT_EDIT_SAVED_RESULT_CONFLICT')
})
export type CurrentEditIntent = z.infer<typeof CurrentEditIntentSchema>
export type CurrentEditDraft = z.infer<typeof CurrentEditDraftSchema>
export const CurrentEditReadResultSchema = z.object({
  intent: CurrentEditIntentSchema.nullable(), current: z.array(GraphEditRunStateSchema),
  canStop: z.boolean(), affectedSetChanged: z.boolean(),
}).strict()
export const CurrentEditMutationInputSchema = z.discriminatedUnion('action', [
  CurrentEditStageInputSchema, CurrentEditAdvanceInputSchema, CurrentEditDiscardInputSchema,
])
/** Object-root MCP schema; the strict union still rejects substituted Stage
 * payloads, arbitrary Stop IDs, cross-action fields and missing exact pins. */
export const CurrentEditMutationToolInputSchema = z.object({
  ...CurrentWorkflowSaveInputSchema.partial().shape,
  stagedAgents: CurrentEditStageInputSchema.shape.stagedAgents,
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  commandId: CurrentWorkflowSaveInputSchema.shape.commandId,
  action: z.enum(['stage_edits', 'stop_and_save', 'discard_edits']),
  draftId: GraphIdSchema, intentId: GraphIdSchema.optional(),
}).strict().superRefine((input, context) => {
  const parsed = CurrentEditMutationInputSchema.safeParse(input)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
