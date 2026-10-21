import {
  IdSchema,
  ListInteractionsRequestSchema,
  AppInteractionListOutputSchema,
  AppInteractionRespondOutputSchema,
  DurableInteractionSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
  HarnessExecutionSchema,
  GraphqlToolDefaultsSchema,
  GraphqlToolOverrideSchema,
  effectiveGraphqlTools,
  type GraphqlAgentTool,
  type WorkflowAgentProductRole,
} from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, WorkerNativeOutputOperationSchema } from '@foreman-code/contracts/worker-native-output'
import { resolveImmutableApprovalRoute } from '../workflows/approvalRoutes.js'
import { assertWave25WorkerBinding } from './wave25/credentialAuthority.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { AgentRunStatus } from '@foreman-code/contracts'
import { AgentRunStatusService } from '../runs/agentRunStatus.js'
import type pg from 'pg'

import { workerScope, workerScopesForAction, hasWorkerAction, requireReadableInteraction, requireRespondableInteraction } from '../access/appPolicy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { PostgresInteractionRepository } from './postgres.js'
import type { InteractionService } from './service.js'
import {
  fitsInteractionMcpResponse, interactionMcpGet, interactionMcpSummary, interactionMcpView,
} from './mcpReadback.js'
import type { InteractionResponseOptions } from './cancellation.js'
import { ignoreError } from '../diagnostics/ignoredError.js'

const CURSOR_PREFIX = 'interaction:'
export const AppInteractionListInputSchema = ListInteractionsRequestSchema.pick({ cursor: true, limit: true }).strict()

function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${id}`, 'utf8').toString('base64url')
}

export function decodeInteractionCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor
      || !decoded.startsWith(CURSOR_PREFIX) || decoded.length === CURSOR_PREFIX.length) throw new Error('invalid')
    const rawId = decoded.slice(CURSOR_PREFIX.length)
    const id = IdSchema.parse(rawId)
    if (id !== rawId || !/^[\x21-\x7e]+$/.test(id)) throw new Error('invalid')
    return id
  } catch {
    throw new DomainError('INVALID_CURSOR', 'The interaction cursor is invalid.', 400)
  }
}

export interface WorkerToolAccess { role: WorkflowAgentProductRole; tools: GraphqlAgentTool[] }

export interface AppInteractionService {
  context(principal: ManagementPrincipal): Promise<unknown>
  canRead(principal: ManagementPrincipal): Promise<boolean>
  canRespond(principal: ManagementPrincipal): Promise<boolean>
  /** The bound Agent's product role and the Foreman Code MCP tools enabled for its pinned configuration and node. */
  toolAccess(principal: ManagementPrincipal): Promise<WorkerToolAccess>
  /** Bounded status of the caller's own Run; only nodes with interval checks may read it. */
  runStatus?(principal: ManagementPrincipal): Promise<AgentRunStatus>
  list(principal: ManagementPrincipal, input: unknown): Promise<unknown>
  get(principal: ManagementPrincipal, interactionId: string, contentCursor?: string): Promise<unknown>
  respond(principal: ManagementPrincipal, input: unknown, options?: InteractionResponseOptions): Promise<unknown>
}

export class PostgresAppInteractionService implements AppInteractionService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly interactions: PostgresInteractionRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly orchestration?: Pick<InteractionService, 'respond'> & Partial<Pick<InteractionService, 'readActivity'>>,
  ) {}
  runStatus(principal: ManagementPrincipal): Promise<AgentRunStatus> { return new AgentRunStatusService(this.pool).read(principal) }
  /** Local shared directory; the harness still controls whether the Agent may write there. */
  syncedFolder?: (workspaceId: string, hostRef: { kind: 'main' } | { kind: 'device'; deviceId: string }) => Promise<string | null>

  async context(principal: ManagementPrincipal) {
    const scope = workerScope(principal)
    const readAllowed = await this.canRead(principal)
    const responseAllowed = await this.canRespond(principal)
    const access = await this.toolAccess(principal)
    const enabled = (tool: string) => access.tools.includes(tool as never)
    const worktree = await this.worktree(principal)
    const sharedFiles = await this.sharedFiles(principal).catch(ignoreError('engine', 'load shared files for interaction view', { principalId: principal.id }))
    return {
      ...(worktree ? { worktree } : {}),
      ...(sharedFiles ? { sharedFiles } : {}),
      principal: {
        id: principal.id,
        audience: 'worker' as const,
        agentId: principal.agentId!,
        expiresAt: principal.expiresAt,
      },
      ...access,
      scope,
      // Only tools enabled for this Agent and node are usable capabilities.
      capabilities: {
        contextGet: true,
        bugReport: hasWorkerAction(principal, 'bug_reports:report') && enabled('bug_report'),
        interactionList: readAllowed && enabled('interaction_list'),
        interactionGet: readAllowed && enabled('interaction_get'),
        interactionRespond: responseAllowed && enabled('interaction_respond'),
      },
    }
  }

  /** The workspace folder on the computer running this bound Agent. */
  private async sharedFiles(principal: ManagementPrincipal) {
    if (!this.syncedFolder) return undefined
    const row = (await this.pool.query<{ device_id: string | null; workspace_id: string }>(
      `select p.record#>>'{materialization,receipt,binding,deviceId}' as device_id, w.id as workspace_id
       from worker_credential_bindings b join execution_native_placements p on p.execution_id=b.execution_id
       join runs r on r.id=b.run_id join workspaces w on w.id=r.workspace_id
       where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null limit 1`, [principal.id, principal.agentId])).rows[0]
    if (!row?.workspace_id) return undefined
    const path = await this.syncedFolder(row.workspace_id,
      row.device_id ? { kind: 'device', deviceId: row.device_id } : { kind: 'main' })
    if (!path) return undefined
    return { provider: 'syncthing' as const, path }
  }

  /** The branch this credential's execution works on; null for workspaces without a repository. */
  private async worktree(principal: ManagementPrincipal) {
    const row = (await this.pool.query<{ worktree: { repository: string; branch: string; commit: string } | null; path: string | null }>(
      `select p.record#>'{materialization,receipt,worktree}' as worktree, p.record#>>'{workingTree,canonicalProjectRoot}' as path
       from worker_credential_bindings b join execution_native_placements p on p.execution_id=b.execution_id
       where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null limit 1`, [principal.id, principal.agentId])).rows[0]
    if (!row?.worktree || !row.path) return undefined
    return { repository: row.worktree.repository, branch: row.worktree.branch, baseCommit: row.worktree.commit, path: row.path }
  }

  async toolAccess(principal: ManagementPrincipal): Promise<WorkerToolAccess> {
    workerScope(principal)
    // The Run pins the exact configuration version and workflow version; both are immutable for this credential.
    const result = await this.pool.query<{ role: string | null; defaults: unknown; override: unknown;
      harness: unknown; artifact_outputs: unknown; purpose: string; local_outputs: boolean; interval: unknown }>(
      `select c.record->>'productRole' as role, c.record->'graphqlTools' as defaults,
         c.record->'harness' as harness,b.purpose,
         ((p.run_id is null and r.record#>>'{executionLocation,runnerId}'='runner-local')
           or p.record#>>'{hostRef,kind}'='main') as local_outputs,
         n->'graphqlTools' as override,n->'artifactOutputs' as artifact_outputs,n->'interval' as interval
       from worker_credential_bindings b
       join runs r on r.id=b.run_id
       join agent_configuration_versions c on c.id=(r.record->'agentConfigurationVersionIds'->>b.agent_id)
         and c.workspace_id=r.workspace_id and c.agent_id=b.agent_id
       join harness_executions e on e.id=b.execution_id and e.run_id=b.run_id and e.agent_id=b.agent_id
       join workflow_versions v on v.id=r.workflow_version_id and v.workspace_id=r.workspace_id
         and v.workflow_id=r.workflow_id
       join lateral jsonb_array_elements(v.record->'definition'->'nodes') n
         on n->>'id'=e.workflow_node_id and n->>'agentId'=b.agent_id
       left join run_node_placements p on p.run_id=r.id and p.node_id=e.workflow_node_id
       where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null`,
      [principal.id, principal.agentId],
    )
    const row = result.rows[0]
    if (!row) throw new DomainError('MCP_TOOL_DISCOVERY_FAILED',
      'The pinned Agent configuration and workflow node could not be loaded. Retry the activation.', 503)
    if (row.role !== 'master' && row.role !== 'orchestrator' && row.role !== 'coder') {
      throw new DomainError('MCP_TOOL_DISCOVERY_FAILED', 'The pinned Agent role is unavailable.', 503)
    }
    const role = row.role
    const defaults = row.defaults == null ? undefined : GraphqlToolDefaultsSchema.parse(row.defaults)
    const override = row.override == null ? undefined : GraphqlToolOverrideSchema.parse(row.override)
    const tools = effectiveGraphqlTools(role, defaults, override, row.interval != null).filter(tool => {
      const operation = WorkerNativeOutputOperationSchema.options.find(operation =>
        WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation] === tool)
      if (!operation) return true
      return false
    })
    return { role, tools }
  }

  async canRead(principal: ManagementPrincipal): Promise<boolean> {
    workerScope(principal)
    return hasWorkerAction(principal, 'interactions:read')
  }

  async canRespond(principal: ManagementPrincipal): Promise<boolean> {
    if (!this.orchestration) return false
    if (!hasWorkerAction(principal, 'interactions:respond') || !hasWorkerAction(principal, 'interactions:read')) return false
    try { await assertWave25WorkerBinding(this.pool, principal.id) }
    catch (error) { if (error instanceof DomainError) return false; throw error }
    workerScope(principal)
    const scopes = workerScopesForAction(principal, 'interactions:respond')
    // Discovery uses the same exact reviewer occurrence as its bound credential.
    // No pending request is required: the entry node discovers tools before handoff.
    const result = await this.pool.query<{ run: unknown; version: unknown; execution: unknown; node_id: string }>(
      `select r.record as run,v.record as version,e.record as execution,e.workflow_node_id as node_id
       from worker_credential_bindings b join harness_executions e on e.id=b.execution_id
         and e.run_id=b.run_id and e.agent_id=b.agent_id
       join runs r on r.id=e.run_id
       join workflow_versions v on v.id=r.workflow_version_id and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
       join agent_configuration_versions c on c.id=(r.record->'agentConfigurationVersionIds'->>$2)
         and c.workspace_id=r.workspace_id and c.agent_id=e.agent_id
       where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null
         and c.record->>'productRole' in ('master','orchestrator')
         and r.execution_state in ('queued','running','waiting')
         and exists (select 1 from jsonb_to_recordset($3::jsonb)
           as response_grant("workspaceIds" text[],"workflowIds" text[],"runIds" text[])
           where r.workspace_id=any(response_grant."workspaceIds")
             and r.workflow_id=any(response_grant."workflowIds") and r.id=any(response_grant."runIds"))`,
      [principal.id, principal.agentId, JSON.stringify(scopes)],
    )
    return result.rows.some((row) => {
      const run = AcceptedWorkflowRunV3Schema.safeParse(row.run)
      const version = WorkflowVersionV3Schema.safeParse(row.version)
      const execution = HarnessExecutionSchema.safeParse(row.execution)
      if (!run.success || !version.success || !execution.success) return false
      const r = run.data, v = version.data, e = execution.data
      if (r.workflowVersionId !== v.id || r.workspaceId !== v.workspaceId || r.workflowId !== v.workflowId
        || v.definition.id !== r.workflowId || v.definition.workspaceId !== r.workspaceId
        || e.runId !== r.id || e.agentId !== principal.agentId || e.workflowNodeId !== row.node_id
        || e.agentConfigurationVersionId !== r.agentConfigurationVersionIds[e.agentId]
        || e.agentConfigurationVersionId !== v.agentConfigurationVersionIds[e.agentId]
        || [r.approval, v.approval, v.definition.approval].some((approval) =>
          approval?.handler !== 'orchestrator' || approval.designatedOrchestratorAgentId !== e.agentId)) return false
      return v.definition.nodes.some((requester) => requester.kind !== 'job' && resolveImmutableApprovalRoute(
        v, requester.id, requester.agentId,
      )?.orchestratorNodeId === e.workflowNodeId)
    })
  }

  async list(principal: ManagementPrincipal, input: unknown) {
    const parsed = AppInteractionListInputSchema.parse(input)
    // The summary scope mixes actions and grants; it is not an authorization predicate.
    workerScope(principal)
    const scopes = workerScopesForAction(principal, 'interactions:read')
    const afterId = decodeInteractionCursor(parsed.cursor)
    const rows = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where status = 'pending'
         and exists (
           select 1 from jsonb_to_recordset($1::jsonb)
             as read_grant("workspaceIds" text[], "workflowIds" text[], "runIds" text[])
           where workspace_id = any(read_grant."workspaceIds")
             and workflow_id = any(read_grant."workflowIds")
             and run_id = any(read_grant."runIds")
         )
         and ($2::text is null or id > $2)
       order by id limit $3`,
      [JSON.stringify(scopes), afterId ?? null, parsed.limit + 1],
    )
    // Visibility is decided before LIMIT. EXISTS also avoids duplicate page slots
    // when more than one read grant authorizes the same interaction.
    const visible = rows.rows.map((row) => DurableInteractionSchema.parse(row.record))
    const items: ReturnType<typeof interactionMcpView>[] = []
    for (const interaction of visible.slice(0, parsed.limit)) {
      let item = interactionMcpView(interaction)
      const nextCursor = encodeCursor(interaction.id)
      if (!fitsInteractionMcpResponse({ items: [...items, item], nextCursor })) {
        if (items.length) break
        item = interactionMcpSummary(interaction)
        if (!fitsInteractionMcpResponse({ items: [item], nextCursor })) {
          throw new DomainError('INTERACTION_METADATA_TOO_LARGE', 'The interaction metadata exceeds the MCP response budget.', 413)
        }
      }
      items.push(item)
    }
    return AppInteractionListOutputSchema.parse({
      items,
      nextCursor: visible.length > items.length ? encodeCursor(items.at(-1)!.id) : null,
    })
  }

  async get(principal: ManagementPrincipal, interactionId: string, contentCursor?: string) {
    const interaction = requireReadableInteraction(principal, await this.interactions.get(interactionId))
    let authorized = false
    try { requireRespondableInteraction(principal, interaction); authorized = await this.canRespond(principal) }
    catch (error) { if (!(error instanceof DomainError)) throw error }
    const activity = await this.orchestration?.readActivity?.(interaction, authorized)
    return interactionMcpGet({ interaction, ...(activity ? { activity } : {}) }, contentCursor)
  }

  async respond(principal: ManagementPrincipal, input: unknown, options: InteractionResponseOptions = {}) {
    const parsed = RespondToInteractionRequestSchema.parse(input)
    let current: ReturnType<typeof DurableInteractionSchema.parse> | undefined
    try {
      current = requireRespondableInteraction(principal, await this.interactions.get(parsed.interactionId))
      if (!this.orchestration) throw new DomainError('APPROVAL_RUNTIME_UNAVAILABLE',
        'The current approval decision service is unavailable.', 503)
      const result = await this.orchestration.respond({
        kind: 'orchestrator', principal,
        authority: {
          agentId: principal.agentId!, workspaceId: current.workspaceId, workflowId: current.workflowId,
        },
      }, parsed, options)
      const response = RespondToInteractionResponseSchema.parse(result)
      return AppInteractionRespondOutputSchema.parse(fitsInteractionMcpResponse(response) ? response : {
        interaction: interactionMcpSummary(response.interaction), replayed: response.replayed,
      })
    } catch (error) {
      const denied = error instanceof DomainError && ['INTERACTION_NOT_FOUND', 'INTERACTION_ACCESS_DENIED'].includes(error.code)
      if (denied) {
        await this.commands.recordDenied(principal.id, 'mcp', 'interaction_respond', 'interaction:requested')
          .catch(ignoreError('engine', 'record denied interaction response audit', { principalId: principal.id }))
      } else {
        await this.commands.recordAudit(principal.id, 'mcp', 'interaction_respond',
          `interaction:${current?.id ?? parsed.interactionId}`, 'failed', {
            code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
          }).catch(ignoreError('engine', 'record failed interaction response audit', { interactionId: parsed.interactionId }))
      }
      throw error
    }
  }
}
