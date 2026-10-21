import { authorizeWorkflowWorktreeContent, validateWorkflowWorktrees,
  type WorkflowWorktreeServices } from './worktreeSettings.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { validateReviewerBootstrap } from './reviewerBootstrap.js'
import { reconcileAgentProfilePlacements } from './agentProfilePlacements.js'
import { requireCurrentWorkflowAccess } from './currentWorkflowPolicy.js'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  workflowSaveIssues, CURRENT_WORKFLOW_CAPABILITIES, DEFAULT_AGENT_ACTIVE_TIMEOUT_MS,
  CurrentWorkflowSaveInputSchema, CurrentWorkflowValidateInputSchema,
  CurrentWorkflowSavedSchema, CurrentWorkflowReadInputSchema, CurrentWorkflowReadResultSchema,
  CurrentWorkflowValidationSchema, WorkflowDefinitionV3Schema, WorkflowVersionV3Schema,
  ExecutableWorkflowV3Schema, canonicalGraphJson, sameAuthoredWorkflow, sameExecutableWorkflow,
  sameWorkflowValue,
  CurrentEditSaveInputSchema, CurrentEditMutationInputSchema, CurrentEditReadInputSchema, preserveWorkflowGeometry,
  type CurrentWorkflowValidateInput, type CurrentEditSaveInput, type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { RunManagementService } from '../runs/management.js'
import type { CurrentRuntimeAvailability } from '../runs/currentProduction.js'
import { createCurrentEditIntentService } from '../graph-drafts/currentEditIntent.js'
import { prepareCurrentStagedAgents, persistCurrentStagedAgents } from '../graph-drafts/currentStagedAgents.js'
import { assertMeaningfulSaveAdmitted } from '../graph-drafts/saveAdmission.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { lockAgentConfigurations } from '../workspaces/agentConfiguration.js'
import { resolveAssignedSkills } from '../skills/catalog.js'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { composeInstructionText, instructionsTooLarge } from '../skills/instructions.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'
import {
  IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableWorkflowVersion, readImmutableAgentConfiguration,
  type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow,
} from './immutableRead.js'

type Source = 'http' | 'mcp'

function parseAuthoringInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const graphInvalid = parsed.error.issues.some((issue) => issue.path[0] === 'graph')
  const issues = workflowSaveIssues(parsed.error.issues.map((issue) => ({
    ...issue, path: issue.path[0] === 'graph' ? issue.path.slice(1) : issue.path,
  })))
  throw new DomainError(
    graphInvalid ? 'GRAPH_INVALID' : 'INVALID_REQUEST',
    graphInvalid ? 'Fix the workflow settings below.' : 'The request does not match the workflow contract.',
    graphInvalid ? 409 : 400,
    { issues },
  )
}

function manualPositionsForSave(graph: WorkflowDefinitionV3, previous: WorkflowDefinitionV3, source?: Source) {
  if (source !== 'mcp') return graph
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]))
  return { ...graph, nodes: graph.nodes.map((node) => {
    const position = node.position
    if (!position || sameWorkflowValue(position, previousNodes.get(node.id)?.position)) return node
    return { ...node, position: { ...position, manual: true } }
  }) }
}
type Scope = { workspaceId: string; workflowId: string }
export interface WorkflowAuthoringOptions {
  agentActiveTimeoutMs?: number | undefined
  worktrees?: WorkflowWorktreeServices | undefined
  accountConfigurations?: ProviderAccountConfigurationService | undefined
}
function completeSaveInput(
  request: CurrentEditSaveInput,
  metadata: CurrentEditSaveInput['graph'],
) {
  const { version, createdAt, updatedAt, ...graph } = request.graph
  const stamps = {
    version: version ?? metadata.version,
    createdAt: createdAt ?? metadata.createdAt,
    updatedAt: updatedAt ?? metadata.updatedAt,
  }
  const approval = graph.approval ?? metadata.approval
  return parseAuthoringInput(CurrentWorkflowSaveInputSchema, { ...request, graph: {
    ...graph,
    ...(approval === undefined ? {} : { approval }),
    ...(stamps.version === undefined ? {} : { version: stamps.version }),
    ...(stamps.createdAt === undefined ? {} : { createdAt: stamps.createdAt }),
    ...(stamps.updatedAt === undefined ? {} : { updatedAt: stamps.updatedAt }),
  } })
}
const fail = (code: string, message: string): never => { throw new DomainError(code, message, 409) }
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
function authorize(principal: ManagementPrincipal, input: Scope & { graph?: WorkflowDefinitionV3 }, write: boolean) {
  requireCurrentWorkflowAccess(principal, write ? 'save' : 'validate', input)
  authorizeWorkflowWorktreeContent(principal, input)
}
async function versionAt(sql: Pick<pg.PoolClient, 'query'>, scope: Scope, id: string) {
  const row = (await sql.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
    from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`, [id, scope.workspaceId, scope.workflowId])).rows[0]
  if (!row) return fail('WORKFLOW_VERSION_NOT_FOUND', 'The exact immutable workflow version is unavailable.')
  const version = WorkflowVersionV3Schema.parse(readImmutableWorkflowVersion(row, { ...scope, id }))
  const rows = (await sql.query<ImmutableAgentConfigurationRow>(
    'select id,workspace_id,agent_id,version,record from agent_configuration_versions where id=any($1::text[]) order by id',
    [Object.values(version.agentConfigurationVersionIds)])).rows
  const configurations = rows.map((row) => {
    const configurationId = version.agentConfigurationVersionIds[row.agent_id]
    if (!configurationId) return fail('WORKFLOW_VERSION_PIN_MISMATCH', 'A configuration is outside the saved version.')
    return readImmutableAgentConfiguration(row, { id: configurationId, workspaceId: scope.workspaceId, agentId: row.agent_id })
  })
  ExecutableWorkflowV3Schema.parse({ version, configurations })
  return { version, configurations }
}

/** Implementation of the EXISTING WorkflowManagementService, for all current
 * graph forms. No execution owner, second engine, native port or mode selector. */
export class CurrentWorkflowAuthoring {
  readonly editIntents: ReturnType<typeof createCurrentEditIntentService>
  private editStop: RunManagementService['stop'] | undefined
  private runtime: Pick<RunManagementService, 'availability' | 'assertCurrentStopReady'> | undefined
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly options: WorkflowAuthoringOptions = {}) {
    this.editIntents = createCurrentEditIntentService(pool, commands, {
      validate: async (client, principal, input, options) => {
        authorize(principal, input, true)
        const prepared = await this.prepare(client, principal, input, false, options?.intentId, options?.source)
        return { version: prepared.version, presentationOnly: prepared.presentationOnly,
          graph: prepared.graph ?? input.graph }
      },
      publish: (principal, source, input, intentId) => this.write(principal, source, input, intentId),
      assertStopReady: () => {
        if (!this.runtime) throw new DomainError('REPEAT_STOP_NOT_READY', 'The production Stop binding is unavailable. No Stop was submitted.', 409)
        this.runtime.assertCurrentStopReady()
      },
    })
  }
  bindEditStop(stop: RunManagementService['stop'], runtime: Pick<RunManagementService, 'availability' | 'assertCurrentStopReady'>): void {
    this.editStop = stop; this.runtime = runtime
  }
  private availability(): CurrentRuntimeAvailability {
    return this.runtime?.availability() ?? { runtimeAdmission: false, stopAvailable: false }
  }
  readEdits(principal: ManagementPrincipal, raw: unknown) {
    return this.editIntents.read(principal, parseAuthoringInput(CurrentEditReadInputSchema, raw))
  }
  mutateEdits(principal: ManagementPrincipal, source: Source, raw: unknown) {
    const input = parseAuthoringInput(CurrentEditMutationInputSchema, raw)
    switch (input.action) {
      case 'stage_edits': return this.editIntents.stage(principal, source, input)
      case 'discard_edits': return this.editIntents.discard(principal, source, input)
      case 'stop_and_save': return this.editIntents.advance(principal, source, input, (...args) => {
        if (!this.editStop) throw new DomainError('REPEAT_STOP_UNAVAILABLE', 'The existing Stop service is not composed. Retain this exact intent.', 503)
        return this.editStop(...args)
      })
    }
  }

  capabilities(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'capabilities:read')
    const availability = this.availability()
    return { ...structuredClone(CURRENT_WORKFLOW_CAPABILITIES), ...availability,
      agentActiveTimeBudget: { ...CURRENT_WORKFLOW_CAPABILITIES.agentActiveTimeBudget,
        defaultMs: this.options.agentActiveTimeoutMs ?? DEFAULT_AGENT_ACTIVE_TIMEOUT_MS },
      meaningfulEdit: availability.stopAvailable,
      editIntents: { ...CURRENT_WORKFLOW_CAPABILITIES.editIntents, stopUnsettled: availability.stopAvailable },
      reasons: [...(availability.runtimeAdmission ? [] : ['NATIVE_START_NOT_READY' as const]),
        ...(availability.stopAvailable ? [] : ['NATIVE_STOP_CLEANUP_NOT_READY' as const])],
    }
  }
  async read(principal: ManagementPrincipal, raw: unknown) {
    const input = parseAuthoringInput(CurrentWorkflowReadInputSchema, raw)
    requireAuthorization(principal, 'workflows:read', input)
    requireAuthorization(principal, 'graph:read', input)
    return withTransaction(this.pool, async (client) => {
      const live = await readLiveManagementPrincipal(client, principal.id)
      requireAuthorization(live, 'workflows:read', input); requireAuthorization(live, 'graph:read', input)
      const row = (await client.query<{ revision: string; current_version_id: string | null }>(
        'select revision::text,current_version_id from workflows where workspace_id=$1 and id=$2 for share',
        [input.workspaceId, input.workflowId])).rows[0]
      if (!row?.current_version_id) return fail('WORKFLOW_NOT_SAVED', 'This workflow has no immutable current version.')
      const { version } = await versionAt(client, input, input.workflowVersionId ?? row.current_version_id)
      const result = CurrentWorkflowReadResultSchema.parse({ workspaceId: input.workspaceId, workflowId: input.workflowId, revision: Number(row.revision),
        currentVersionId: row.current_version_id, version })
      return result
    })
  }
  async validate(principal: ManagementPrincipal, raw: unknown) {
    const input = parseAuthoringInput(CurrentWorkflowValidateInputSchema, raw)
    authorize(principal, input, false)
    return withTransaction(this.pool, async (client) => {
      const live = await readLiveManagementPrincipal(client, principal.id)
      authorize(live, input, false)
      await this.prepare(client, live, input, false)
      return CurrentWorkflowValidationSchema.parse({ valid: true, executionSemanticsVersion: 3,
        expectedRevision: input.expectedRevision, expectedWorkflowVersionId: input.expectedWorkflowVersionId,
        expectedAgentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds,
        ...this.availability() })
    })
  }
  save(principal: ManagementPrincipal, source: Source, raw: unknown) {
    return this.write(principal, source, raw)
  }
  private async write(principal: ManagementPrincipal, source: Source, raw: unknown, intentId?: string) {
    // Preserve optional-repeat omission in the exact HTTP/MCP command hash.
    let input: CurrentEditSaveInput = intentId
      ? parseAuthoringInput(CurrentEditSaveInputSchema, raw)
      : parseAuthoringInput(CurrentWorkflowSaveInputSchema, raw)
    const request = input
    const needsMetadata = !intentId && (input.graph.version === undefined
      || input.graph.createdAt === undefined || input.graph.updatedAt === undefined || input.graph.approval === undefined)
    authorize(principal, input, true)
    return this.commands.execute({ principal, source, operation: 'workflow.save.v3', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}:definition`, payload: request,
      replayResult: (raw) => {
        const saved = CurrentWorkflowSavedSchema.parse(raw)
        if (saved.workspaceId !== input.workspaceId || saved.workflowId !== input.workflowId) {
          return fail('WORKFLOW_RECEIPT_CONFLICT', 'The stored result escaped its command scope.')
        }
        return saved
      },
      authorize: async (client) => {
        principal = await readLiveManagementPrincipal(client, principal.id)
        authorize(principal, input, true)
        if (intentId) await this.editIntents.authorizeSave(client, principal, intentId, input)
        else if ((await client.query(`select 1 from graph_edit_intents where principal_id=$1
          and record->'saveInput'->>'commandId'=$2 limit 1`, [principal.id, input.commandId])).rowCount) {
          return fail('GRAPH_EDIT_USE_INTENT', 'This Save belongs to a durable edit intent. Reconcile its exact reserved command through that intent.')
        }
        // Receipt replay is independent of current Agent/location/workflow heads.
        const receipt = (await client.query<{ result: unknown; input_hash: string; target_key: string }>(`select result,input_hash,target_key from management_command_receipts
          where principal_id=$1 and operation='workflow.save.v3' and command_id=$2`, [principal.id, input.commandId])).rows[0]
        if (receipt) {
          if (receipt.input_hash !== commandInputHash(request) || receipt.target_key !== `workflow:${input.workflowId}:definition`) {
            return fail('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')
          }
          const saved = CurrentWorkflowSavedSchema.parse(receipt.result)
          const witness = (await client.query<{ workflow_version_id: string; input_hash: string; input: unknown }>(
            `select workflow_version_id,input_hash,input from current_workflow_publications where principal_id=$1 and command_id=$2`,
            [principal.id, input.commandId])).rows[0]
          if (needsMetadata) {
            const metadata = witness ? CurrentWorkflowSaveInputSchema.parse(witness.input).graph
              : saved.presentation ?? saved.version.definition
            input = completeSaveInput(request, metadata)
          }
          const { version, configurations } = await versionAt(client, input, saved.currentVersionId)
          // Replays use saved configurations even when the Agent has since changed.
          let publishedInput = witness && !sameWorkflowValue(witness.input, input)
            ? { ...input, graph: reconcileAgentProfilePlacements(input.graph, configurations) } : input
          // Existing witnesses can record profile reconciliation without manual position flags.
          if (witness && !sameWorkflowValue(witness.input, publishedInput)) {
            publishedInput = { ...publishedInput,
              graph: manualPositionsForSave(publishedInput.graph, version.definition, source) }
          }
          if (!sameWorkflowValue(version, saved.version) || !sameWorkflowValue(version.agentConfigurationVersionIds, input.resultantAgentConfigurationVersionIds ?? input.expectedAgentConfigurationVersionIds)) {
            return fail('WORKFLOW_RECEIPT_CONFLICT', 'The receipt differs from its exact immutable version/configuration pins.')
          }
          if (saved.presentation && !sameAuthoredWorkflow(saved.presentation, input.graph)) {
            return fail('WORKFLOW_RECEIPT_CONFLICT', 'The saved presentation differs from the submitted node names.')
          }
          if (witness ? witness.workflow_version_id !== version.id || witness.input_hash !== commandInputHash(request)
              || !sameWorkflowValue(witness.input, publishedInput) || saved.revision !== input.expectedRevision + 1
              || !sameExecutableWorkflow(version.definition, publishedInput.graph)
            : version.id !== input.expectedWorkflowVersionId || saved.revision !== input.expectedRevision
              || input.graph.version !== version.version || !sameExecutableWorkflow(version.definition,
                { ...input.graph, name: version.definition.name, description: version.definition.description })) {
            return fail('WORKFLOW_RECEIPT_CONFLICT', 'The stored command result has no matching typed publication or exact presentation-save backing.')
          }
        } else if (needsMetadata) {
          await lockActiveWorkspace(client, input.workspaceId)
          const row = (await client.query<{ record: unknown }>(
            'select record from workflows where workspace_id=$1 and id=$2 for update',
            [input.workspaceId, input.workflowId])).rows[0]
          if (!row) return fail('WORKFLOW_UNAVAILABLE', 'The active workflow was not found in this scope.')
          input = completeSaveInput(request, WorkflowDefinitionV3Schema.parse(row.record))
        }
      },
      perform: (client) => this.publish(client, principal, source, input, request, intentId),
    })
  }

  async saveInitial(client: pg.PoolClient, principal: ManagementPrincipal, source: Source, raw: unknown) {
    const input = parseAuthoringInput(CurrentWorkflowSaveInputSchema, raw)
    authorize(principal, input, true)
    const value = await this.publish(client, principal, source, input, input)
    // The publication guard requires its save receipt and audit in this transaction.
    await client.query(`insert into management_command_receipts
      (principal_id, operation, command_id, target_key, input_hash, result)
      values ($1, 'workflow.save.v3', $2, $3, $4, $5::jsonb)`,
    [principal.id, input.commandId, `workflow:${input.workflowId}:definition`,
      commandInputHash(input), JSON.stringify(value)])
    await this.commands.recordAudit(principal.id, source, 'workflow.save.v3',
      `workflow:${input.workflowId}:definition`, 'succeeded', { commandId: input.commandId }, client)
    return value
  }

  private async publish(client: pg.PoolClient, principal: ManagementPrincipal, source: Source,
    input: CurrentEditSaveInput, request: CurrentEditSaveInput, intentId?: string) {
    if (intentId) await this.editIntents.publication(client, principal, intentId, input)
    // Staged graphs already have the normalization recorded by their command hash.
    const prepared = await this.prepare(client, principal, input, true, intentId, intentId ? undefined : source)
    const agents = prepared.staged ? await persistCurrentStagedAgents(client, input.workspaceId, prepared.staged.prepared) : undefined
    let revision: number
    if (prepared.presentationOnly) {
      // This changes presentation, not accepted execution. No Stop, no new
      // immutable version or semantic revision, so a staged intent survives
      // free layout changes. No synthetic publication witness is needed.
      const row = (await client.query<{ revision: string }>(`update workflows set record=$3::jsonb
        where workspace_id=$1 and id=$2 and revision=$4 and current_version_id=$5 returning revision::text`,
      [input.workspaceId, input.workflowId, canonicalGraphJson(prepared.definition), input.expectedRevision,
        input.expectedWorkflowVersionId])).rows[0]
      if (!row) return fail('REVISION_CONFLICT', 'The workflow changed during presentation save.')
      revision = Number(row.revision)
    } else {
      await client.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
        values($1,$2,$3,$4,$5,$6::jsonb,3)`, [prepared.version.id, input.workspaceId, input.workflowId,
      prepared.version.version, prepared.version.entryNodeId, canonicalGraphJson(prepared.version)])
      const row = (await client.query<{ revision: string }>(
        'select eng04_publish_current_workflow($1,$2,$3::jsonb,$4,$5,$6)::text as revision',
        [principal.id, source, canonicalGraphJson({ ...input, graph: prepared.graph }),
          commandInputHash(request), prepared.version.id, prepared.content])).rows[0]
      if (!row) return fail('REVISION_CONFLICT', 'The typed current workflow publication returned no revision.')
      revision = Number(row.revision)
    }
    const live = await readLiveManagementPrincipal(client, principal.id)
    authorize(live, input, true)
    const value = CurrentWorkflowSavedSchema.parse({ workspaceId: input.workspaceId, workflowId: input.workflowId,
      revision, currentVersionId: prepared.version.id, version: prepared.version,
      ...(prepared.presentationOnly ? { presentation: prepared.definition } : {}), ...(agents ? { agents } : {}) })
    if (intentId) await this.editIntents.saved(client, principal, intentId, value)
    return value
  }

  private async prepare(client: pg.PoolClient, principal: ManagementPrincipal,
    input: CurrentWorkflowValidateInput | CurrentEditSaveInput, publication: boolean, intentId?: string, source?: Source) {
    await lockActiveWorkspace(client, input.workspaceId)
    const row = (await client.query<{ record: unknown; revision: string; current_version_id: string | null; archived_at: Date | null }>(
      'select record,revision::text,current_version_id,archived_at from workflows where workspace_id=$1 and id=$2 for update',
      [input.workspaceId, input.workflowId])).rows[0]
    if (!row || row.archived_at) return fail('WORKFLOW_UNAVAILABLE', 'The active workflow was not found in this scope.')
    if (Number(row.revision) !== input.expectedRevision) return fail('REVISION_CONFLICT', 'The displayed workflow revision changed.')
    if (row.current_version_id !== input.expectedWorkflowVersionId) return fail('WORKFLOW_BASE_CONFLICT', 'The immutable workflow head changed.')
    const current = WorkflowDefinitionV3Schema.parse(row.record)
    if (current.id !== input.workflowId || current.workspaceId !== input.workspaceId
      || input.graph.id !== input.workflowId || input.graph.workspaceId !== input.workspaceId
      || input.graph.version !== current.version || input.graph.createdAt !== current.createdAt) {
      return fail('WORKFLOW_BASE_CONFLICT', 'The definition does not match its exact scope and base stamps.')
    }
    const snapshot = row.current_version_id ? await versionAt(client, input, row.current_version_id) : undefined
    const base = snapshot?.version
    if (base && (current.version !== base.version || !sameExecutableWorkflow({ ...current,
      name: base.definition.name, description: base.definition.description }, base.definition))) {
      return fail('WORKFLOW_BASE_CONFLICT', 'The current definition disagrees with its immutable executable version.')
    }
    const stagedInput = 'stagedAgents' in input && input.stagedAgents?.length ? input as CurrentEditSaveInput : undefined
    const staged = stagedInput ? await prepareCurrentStagedAgents(client, principal, stagedInput, this.options.accountConfigurations) : undefined
    const configurationPins = staged?.resultant ?? input.expectedAgentConfigurationVersionIds
    let presentationOnly = !staged && !!base && sameExecutableWorkflow(current, input.graph)
      && sameWorkflowValue(base.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)
    if (presentationOnly && snapshot) {
      presentationOnly = sameExecutableWorkflow(input.graph,
        reconcileAgentProfilePlacements(input.graph, snapshot.configurations))
    }
    if (presentationOnly && base) {
      await validateWorkflowWorktrees({ sql: client, principal, definition: input.graph, previous: current,
        services: this.options.worktrees })
      return { presentationOnly, version: base, content: '',
        definition: manualPositionsForSave(WorkflowDefinitionV3Schema.parse({
          ...(intentId ? preserveWorkflowGeometry(input.graph, current) : input.graph),
          updatedAt: new Date().toISOString() }), current, source) }
    }

    if (publication) {
      await assertMeaningfulSaveAdmitted(client, { ...input, stagedAgentIds: staged?.prepared.map((item) => item.agent.id) ?? [] })
      // Every meaningful edit shares this current journal. No old draft row is
      // a prerequisite or a source of current execution authority.
      if ((await client.query(`select 1 from graph_edit_intents where workspace_id=$1 and workflow_id=$2
        and state not in ('saved','discarded') and ($3::text is null or id<>$3) limit 1`,
      [input.workspaceId, input.workflowId, intentId ?? null])).rowCount) return fail('WORKFLOW_EDITS_UNRESOLVED', 'Reconcile the existing staged edit before publishing another definition.')
    }
    const agentIds = Object.keys(configurationPins).sort()
    const nodeAgents = [...new Set(input.graph.nodes.filter((node) => node.kind !== 'job').map((node) => node.agentId))].sort()
    if (!sameWorkflowValue(agentIds, nodeAgents)) return fail('AGENT_CONFIGURATION_CONFLICT', 'Pins must describe exactly the authored Agent set.')
    await lockAgentConfigurations(client, agentIds)
    const heads = (await client.query<{ id: string; current_configuration_version_id: string | null }>(
      'select id,current_configuration_version_id from agents where workspace_id=$1 and id=any($2::text[]) and archived_at is null order by id for share',
      [input.workspaceId, agentIds])).rows
    if (heads.length !== agentIds.length - (staged?.prepared.filter((item) => item.baseRevision === null).length ?? 0)) {
      return fail('AGENT_CONFIGURATION_CONFLICT', 'A referenced Agent is unavailable in this workspace.')
    }
    const rows = (await client.query<ImmutableAgentConfigurationRow>(
      'select id,workspace_id,agent_id,version,record from agent_configuration_versions where id=any($1::text[]) order by id for share',
      [Object.values(input.expectedAgentConfigurationVersionIds)])).rows
    const configurations = rows.filter((config) => !staged?.prepared.some((item) => item.agent.id === config.agent_id)).map((config) => {
      const id = input.expectedAgentConfigurationVersionIds[config.agent_id]
      if (!id) return fail('AGENT_CONFIGURATION_CONFLICT', 'A configuration escaped the displayed Agent map.')
      return readImmutableAgentConfiguration(config, { workspaceId: input.workspaceId, agentId: config.agent_id, id })
    })
    configurations.push(...(staged?.prepared.map((item) => item.configuration) ?? []))
    // Publication and the immutable version must use the same manual placement flags and inherited approval.
    const graph = manualPositionsForSave(reconcileAgentProfilePlacements({ ...input.graph,
      approval: input.graph.approval ?? current.approval }, configurations), current, source)
    await validateWorkflowWorktrees({ sql: client, principal, definition: graph, previous: current,
      configurations, services: this.options.worktrees })
    const number = Number((await client.query<{ next: string }>('select coalesce(max(version),0)+1 as next from workflow_versions where workflow_id=$1',
      [input.workflowId])).rows[0]?.next)
    if (!Number.isSafeInteger(number) || number < 1 || base && number <= base.version) return fail('WORKFLOW_BASE_CONFLICT', 'The next immutable version is invalid.')
    const now = new Date().toISOString()
    const parsedVersion = WorkflowVersionV3Schema.safeParse({ id: `workflow-version-${randomUUID()}`, workspaceId: input.workspaceId,
      workflowId: input.workflowId, version: number, executionSemanticsVersion: 3, entryNodeId: input.graph.entryNodeId,
      definition: { ...preserveWorkflowGeometry(graph, current), version: number, updatedAt: now }, approval: graph.approval,
      agentConfigurationVersionIds: configurationPins, contentHash: `sha256:${'0'.repeat(64)}`, createdAt: now })
    if (!parsedVersion.success) throw new DomainError('GRAPH_INVALID', 'Fix the workflow settings below.', 409, { issues: workflowSaveIssues(parsedVersion.error.issues) })
    const version = parsedVersion.data
    const executable = ExecutableWorkflowV3Schema.safeParse({ version, configurations })
    if (!executable.success) throw new DomainError('GRAPH_INVALID', 'Fix the workflow settings below.', 409, { issues: workflowSaveIssues(executable.error.issues) })
    for (const node of version.definition.nodes) {
      if (node.kind === 'job') continue
      const configuration = configurations.find(config => config.agentId === node.agentId)!
      const additions = await resolveAssignedSkills(client, input.workspaceId, node.skills?.add ?? [],
        base?.nodeSkillSnapshots?.[node.id])
      if (additions.length) {
        version.nodeSkillSnapshots ??= {}
        version.nodeSkillSnapshots[node.id] = additions
      }
      const effective = node.skills ? configurationWithNodeSkills(configuration, node.skills, additions) : configuration
      if (instructionsTooLarge(composeInstructionText(effective))) {
        throw new DomainError('AGENT_INSTRUCTIONS_TOO_LARGE',
          'Agent instructions and node skills exceed the 512 KiB limit. Remove skills or shorten the instructions.', 400)
      }
    }
    for (const config of configurations) {
      if (config.assignedSkills?.length) requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
      if (config.harness.harness === 'codex' && config.harness.sandbox === 'danger-full-access') requireAuthorization(principal, 'harnesses:update', input)
      assertNativeWorkflowConfiguration(config.harness, version.approval,
        version.approval.handler === 'orchestrator' && config.agentId === version.approval.designatedOrchestratorAgentId)
    }
    if (version.approval.handler === 'orchestrator') validateReviewerBootstrap(version.definition, version.approval,
      configurations.find((config) => config.agentId === version.approval.designatedOrchestratorAgentId)?.harness, version.entryNodeId)
    const content = canonicalGraphJson({ definition: version.definition, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })
    version.contentHash = digest(content)
    return { presentationOnly: false, version, definition: version.definition, graph, content, staged }
  }
}
