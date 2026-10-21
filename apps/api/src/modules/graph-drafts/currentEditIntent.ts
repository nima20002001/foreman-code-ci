import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  CurrentEditDraftSchema, CurrentEditIntentSchema, CurrentEditReadResultSchema, CurrentEditStageInputSchema,
  CurrentEditSaveInputSchema, CurrentWorkflowSavedSchema, WorkflowVersionV3Schema,
  sameExecutableWorkflow, sameWorkflowValue,
  type CurrentEditIntent, type CurrentEditStageInput, type CurrentEditDraft,
  type CurrentEditSaveInput, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import { authorizeWorkflowWorktreeContent } from '../workflows/worktreeSettings.js'
import { requireCurrentWorkflowAccess } from '../workflows/currentWorkflowPolicy.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockAgentConfigurations } from '../workspaces/agentConfiguration.js'
import { authorizeStagedAgents, resolveNewStagedAgentDefaults } from './currentStagedAgents.js'
import { DurableEditIntentService, type EditIntentSource } from './durableEditIntent.js'
import { IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableWorkflowVersion,
  type ImmutableWorkflowVersionRow } from '../workflows/immutableRead.js'

async function requiresRunSettlement(client: pg.PoolClient, draft: CurrentEditDraft): Promise<boolean> {
  if (draft.presentationOnly) return false
  if (draft.stagedAgents?.length || !draft.baseWorkflowVersionId) return true
  const row = (await client.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
    from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
  [draft.baseWorkflowVersionId, draft.workspaceId, draft.workflowId])).rows[0]
  if (!row) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The staged workflow version is unavailable.', 409)
  const base = WorkflowVersionV3Schema.parse(readImmutableWorkflowVersion(row, {
    id: draft.baseWorkflowVersionId, workspaceId: draft.workspaceId, workflowId: draft.workflowId,
  }))
  return !sameExecutableWorkflow(base.definition, draft.graph)
    || !sameWorkflowValue(base.agentConfigurationVersionIds, draft.agentConfigurationVersionIds)
}

export interface CurrentEditWriter {
  assertStopReady(): void
  validate(client: pg.PoolClient, principal: ManagementPrincipal, input: CurrentEditSaveInput,
    options?: { intentId?: string; source?: EditIntentSource }):
    Promise<{ version: WorkflowVersionV3; presentationOnly: boolean; graph: CurrentEditSaveInput['graph'] }>
  publish(principal: ManagementPrincipal, source: EditIntentSource, input: CurrentEditSaveInput, intentId: string): Promise<unknown>
}
/** Same durable Stage/Discard/Stop-and-save coordinator, now with a complete
 * semantics-3 payload. Stage is private; Agent writes occur only inside the
 * existing final publication transaction. No new Stop/native implementation. */
export function createCurrentEditIntentService(pool: pg.Pool, commands: PostgresCommandCoordinator, writer: CurrentEditWriter) {
  return new DurableEditIntentService<CurrentEditStageInput, CurrentEditIntent>(pool, commands, {
    kind: 'current', stageSchema: CurrentEditStageInputSchema, intentSchema: CurrentEditIntentSchema,
    readResultSchema: CurrentEditReadResultSchema, resultSchema: CurrentWorkflowSavedSchema,
    authorize: (principal, scope, write) => {
      requireCurrentWorkflowAccess(principal, write ? 'save' : 'validate', scope)
      authorizeWorkflowWorktreeContent(principal, scope)
    },
    authorizeContent: (principal, intent) => {
      authorizeStagedAgents(principal, intent.saveInput)
      authorizeWorkflowWorktreeContent(principal, intent.saveInput)
    },
    stagedAgentIds: (draft) => (draft.stagedAgents ?? []).map((item) => item.agent.id),
    requiresRunSettlement,
    prepare: async (client, principal, input, saveCommandId, source) => {
      const { action, draftId, commandId, ...definition } = input
      void action; void commandId
      let saveInput = CurrentEditSaveInputSchema.parse({ ...definition, commandId: saveCommandId })
      authorizeStagedAgents(principal, saveInput)
      saveInput = await resolveNewStagedAgentDefaults(client, saveInput)
      const validated = await writer.validate(client, principal, saveInput, { source })
      const { version, presentationOnly } = validated
      const graph = { ...validated.graph, approval: version.approval }
      saveInput = CurrentEditSaveInputSchema.parse({ ...saveInput, graph })
      if (input.stagedAgents?.length) saveInput = CurrentEditSaveInputSchema.parse({ ...saveInput,
        resultantAgentConfigurationVersionIds: version.agentConfigurationVersionIds })
      else if (!sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) {
        throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'The Stage configuration pins changed.', 409)
      }
      const ids = Object.keys(version.agentConfigurationVersionIds).sort()
      await lockAgentConfigurations(client, ids)
      const heads = (await client.query<{ id: string; metadata_revision: string; current_configuration_version_id: string | null }>(
        `select id,metadata_revision::text,current_configuration_version_id from agents
         where workspace_id=$1 and id=any($2::text[]) and archived_at is null order by id for share`, [input.workspaceId, ids])).rows
      const agentPins = ids.map((id) => {
        const row = heads.find((head) => head.id === id)
        if (!row && input.stagedAgents?.some((item) => item.agent.id === id && item.baseRevision === null)) {
          return { agentId: id, metadataRevision: null, configurationVersionId: null }
        }
        if (!row || !Number.isSafeInteger(Number(row.metadata_revision)) || Number(row.metadata_revision) < 0) {
          throw new DomainError('AGENT_REVISION_CONFLICT', 'A referenced Agent is unavailable in this workspace.', 409)
        }
        return { agentId: id, metadataRevision: Number(row.metadata_revision),
          configurationVersionId: input.expectedAgentConfigurationVersionIds[id]! }
      })
      const stagedDraft = CurrentEditDraftSchema.parse({ id: draftId, workspaceId: input.workspaceId,
        workflowId: input.workflowId, revision: input.expectedRevision, baseWorkflowVersionId: input.expectedWorkflowVersionId,
        graph: saveInput.graph, agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds,
        ...(presentationOnly ? { presentationOnly: true } : {}),
        ...(saveInput.stagedAgents ? { stagedAgents: saveInput.stagedAgents } : {}),
        ...(input.stagedAgents?.length ? { resultantAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
          saveCommandId } : {}) })
      return { stagedDraft, saveInput, savedWorkflowRevision: input.expectedRevision,
        agentPins }
    },
    authorizePublication: async (client, principal, intent) => {
      const draft = intent.stagedDraft
      // Fresh complete validation and authority BEFORE each Stop and final Save.
      await writer.validate(client, principal, { workspaceId: draft.workspaceId, workflowId: draft.workflowId,
        executionSemanticsVersion: 3, expectedRevision: draft.revision, expectedWorkflowVersionId: draft.baseWorkflowVersionId,
        expectedAgentConfigurationVersionIds: draft.agentConfigurationVersionIds,
        graph: draft.graph, commandId: draft.saveCommandId ?? 'validate-current-draft', stagedAgents: draft.stagedAgents,
        resultantAgentConfigurationVersionIds: draft.resultantAgentConfigurationVersionIds }, { intentId: intent.id })
    },
    assertStopReady: () => writer.assertStopReady(),
    saveInputHash: (input) => commandInputHash(input), resultScope: (result) => result,
    publish: (principal, source, input, intentId) => writer.publish(principal, source, input, intentId),
  })
}
