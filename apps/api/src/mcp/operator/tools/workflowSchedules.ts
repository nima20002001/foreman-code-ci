import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { ManagementActionSchema, type ManagementAction } from '@foreman-code/contracts/management'
import { CurrentOperatorCapabilitiesSchema, CurrentOperatorToolNameSchema } from '@foreman-code/contracts/wave25'
import {
  ScheduleDisableInputSchema, ScheduleDisableResultSchema, ScheduleGetInputSchema, ScheduleGetResultSchema,
  ScheduleSaveInputSchema, ScheduleSaveResultSchema,
} from '@foreman-code/contracts/schedules'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import { DomainError } from '../../../modules/errors.js'
import {
  ScheduleClearInputSchema, ScheduleClearResultSchema, ScheduleEnableInputSchema, ScheduleEnableResultSchema,
  ScheduleOccurrenceListInputSchema, ScheduleOccurrencePageSchema,
} from '../../../modules/schedules/transportSchemas.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'
import { WORKFLOW_SCHEDULE_TOOLS, type WorkflowScheduleToolName } from '../toolNames.js'

export { WORKFLOW_SCHEDULE_TOOLS, type WorkflowScheduleToolName }
const actions: Record<WorkflowScheduleToolName, ManagementAction> = {
  workflow_schedule_get: 'workflows:read', workflow_schedule_occurrences_list: 'workflows:read',
  workflow_schedule_save: 'workflows:update', workflow_schedule_enable: 'workflows:update',
  workflow_schedule_disable: 'workflows:update', workflow_schedule_clear: 'workflows:update',
}
const scheduleTimeContract = 'Calendar time input requires the caller device\'s IANA timezone, never the server timezone. New Once settings are normalized to UTC; weekly weekday/time intent retains its source timezone for DST. All nextOccurrenceAt, anchorAt and dueAt values are canonical UTC instants; format those instants in the viewing device timezone without reinterpreting them. Read or unchanged saves must preserve existing weekly calendar intent; an intentional weekday/time edit may choose the editing device timezone.'
const scheduleCursorContract = 'Saving unchanged enabled settings or enabling an already-enabled schedule preserves its occurrence cursor while updating the revision and owner binding. Re-enabling unchanged Once settings retains exhaustion and never creates another occurrence; future-time validation applies only to new or changed times.'

/** Schedule tools extend the shared Operator discovery names. */
const CapabilityToolName = z.enum([...CurrentOperatorToolNameSchema.options, ...WORKFLOW_SCHEDULE_TOOLS])
export const ScheduleOperatorCapabilitiesSchema = CurrentOperatorCapabilitiesSchema.extend({
  tools: z.array(CapabilityToolName),
  requirements: z.array(z.object({ name: CapabilityToolName,
    actions: z.array(ManagementActionSchema), detail: z.string() }).strict()).optional(),
}).strict()

export function workflowScheduleToolAvailable(context: OperatorRequestContext, name: WorkflowScheduleToolName,
  resource: AuthorizedResource = {}): boolean {
  if (!context.services.workflows?.schedules) return false
  return Object.keys(resource).length ? isAuthorized(context.principal, actions[name], resource)
    : hasAction(context.principal, actions[name])
}
export function workflowScheduleCapabilities(context: OperatorRequestContext, resource: AuthorizedResource) {
  return WORKFLOW_SCHEDULE_TOOLS.filter((name) => workflowScheduleToolAvailable(context, name, resource))
    .map((name) => ({ name, actions: [actions[name]],
      detail: 'Workspace/workflow scope; live authority is rechecked, including command replay. Saving does not immediately start a Run. The API dispatcher attempts only the latest due within five minutes, skips overlapping scheduled Runs, and uses the latest saved workflow. Admission requires the bound human owner\'s current runs:start and workspace_locations:read rights within the captured writer grant ceiling. Occurrence paging uses the shared schedule contracts. ' + scheduleTimeContract + ' ' + scheduleCursorContract }))
}

export function registerWorkflowScheduleTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.workflows?.schedules
  if (!service) return
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (workflowScheduleToolAvailable(context, 'workflow_schedule_get')) server.registerTool('workflow_schedule_get', {
    description: 'Read the one persisted schedule for a workflow, or null when absent. Read first to obtain expectedRevision. This does not dispatch or start a Run. ' + scheduleTimeContract,
    inputSchema: ScheduleGetInputSchema, outputSchema: ScheduleGetResultSchema, annotations: read,
  }, (input) => invokeOperatorTool(context, 'workflow_schedule_get', () => service.get(context.principal, input)))
  if (workflowScheduleToolAvailable(context, 'workflow_schedule_save')) server.registerTool('workflow_schedule_save', {
    description: 'Create or replace weekly, elapsed interval (whole seconds, minutes or hours, at least one second), or Once settings. New or changed Once settings must be in the future. Use revision 0 for absence, otherwise the read revision, and retain commandId for retries. Policy is latest_saved. Saving does not immediately start a Run. Enabled saves bind the writer\'s root human owner and grant ceiling for server-side dispatch. At dispatch the owner must still have runs:start and workspace_locations:read. Older unbound schedules require a new save or enable; read occurrence history for outcomes. ' + scheduleTimeContract + ' ' + scheduleCursorContract,
    inputSchema: ScheduleSaveInputSchema, outputSchema: ScheduleSaveResultSchema, annotations: write,
  }, (input) => invokeOperatorTool(context, 'workflow_schedule_save', () => service.save(context.principal, 'mcp', input)))
  if (workflowScheduleToolAvailable(context, 'workflow_schedule_enable')) server.registerTool('workflow_schedule_enable', {
    description: 'Enable existing saved settings with commandId and expectedRevision, including an exhausted Once. This binds the enabling caller\'s root human owner and grant ceiling for future server dispatch; it does not immediately start a Run. Live owner Run and location rights are rechecked at dispatch. ' + scheduleCursorContract,
    inputSchema: ScheduleEnableInputSchema, outputSchema: ScheduleEnableResultSchema, annotations: write,
  }, (input) => invokeOperatorTool(context, 'workflow_schedule_enable', () => service.enable(context.principal, 'mcp', input)))
  if (workflowScheduleToolAvailable(context, 'workflow_schedule_disable')) server.registerTool('workflow_schedule_disable', {
    description: 'Disable an existing schedule with commandId and expectedRevision, retaining its configuration and history. Future admissions only: accepted Runs are not canceled and legacy scheduling is never revived.',
    inputSchema: ScheduleDisableInputSchema, outputSchema: ScheduleDisableResultSchema, annotations: write,
  }, (input) => invokeOperatorTool(context, 'workflow_schedule_disable', () => service.disable(context.principal, 'mcp', input)))
  if (workflowScheduleToolAvailable(context, 'workflow_schedule_clear')) server.registerTool('workflow_schedule_clear', {
    description: 'Clear an existing schedule with commandId and expectedRevision. Get then returns null. Retain immutable occurrences, command receipts and an internal revision/authority tombstone. Never cancel Runs or revive legacy scheduling.',
    inputSchema: ScheduleClearInputSchema, outputSchema: ScheduleClearResultSchema,
    annotations: { ...write, destructiveHint: true },
  }, (input) => invokeOperatorTool(context, 'workflow_schedule_clear', () => service.clear(context.principal, 'mcp', input)))
  if (workflowScheduleToolAvailable(context, 'workflow_schedule_occurrences_list')) server.registerTool('workflow_schedule_occurrences_list', {
    description: 'Read newest-first immutable accepted/skipped/missed/rejected occurrences and reasons, including history after clear. Default 50, maximum 100. Continue with the returned workflow-bound cursor.',
    inputSchema: ScheduleOccurrenceListInputSchema, outputSchema: ScheduleOccurrencePageSchema, annotations: read,
  }, (input) => invokeOperatorTool(context, 'workflow_schedule_occurrences_list', () => service.recentOccurrences(context.principal, input)))
}

const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(WORKFLOW_SCHEDULE_TOOLS) }).passthrough(),
}).passthrough()

/** A direct call to a grant-hidden write still receives an explicit, audited denial. */
export async function unavailableWorkflowScheduleToolCall(context: OperatorRequestContext, body: unknown) {
  const parsed = ToolCall.safeParse(body)
  if (!parsed.success || workflowScheduleToolAvailable(context, parsed.data.params.name)) return undefined
  const { id, params: { name } } = parsed.data
  const result = await invokeOperatorTool(context, name, async () => {
    if (!context.services.workflows?.schedules) {
      throw new DomainError('SCHEDULES_UNAVAILABLE', 'Schedule persistence is not configured.', 503)
    }
    throw new DomainError('ACCESS_DENIED', 'The caller lacks the required schedule read or write grant.', 403)
  })
  return { jsonrpc: '2.0' as const, id, result }
}
