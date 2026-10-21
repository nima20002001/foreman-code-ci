import { z } from 'zod'
import { OperatorCapabilitiesSchema, OperatorToolNameSchema, ManagementActionSchema } from '../management/index.js'
import { RUN_INSPECTION_TOOLS } from './runInspection.js'
import { CURRENT_WORKFLOW_TOOLS } from './currentAuthoring.js'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS } from './repeatGraphMetadata.js'

/** Management and graph wire versions are independent of execution semantics.
 * Replace the retired executable tool names, not the transport envelope. */
export const RETIRED_EXECUTION_TOOLS = [
  'repeat_capabilities_get', 'repeat_get', 'repeat_update', 'repeat_run_get',
  'graph_draft_open', 'graph_draft_get', 'graph_draft_apply', 'graph_draft_layout',
  'graph_draft_revert_applied', 'graph_draft_discard', 'graph_validate', 'graph_save',
  'workflow_trigger_get', 'workflow_trigger_update', 'workflow_trigger_disable', 'workflow_trigger_fire', 'workflow_trigger_jobs_list',
  'run_current_get_v1', 'run_history_get_v1', 'run_resume', 'run_retry',
] as const
export const CurrentOperatorToolNameSchema = z.enum([
  ...OperatorToolNameSchema.options.filter((name) => !RETIRED_EXECUTION_TOOLS.some((retired) => retired === name)),
  ...Object.values(CURRENT_WORKFLOW_TOOLS), ...Object.values(CANONICAL_RUN_GRAPH_MCP_TOOLS),
  ...Object.values(RUN_INSPECTION_TOOLS),
])
export const CurrentOperatorCapabilitiesSchema = OperatorCapabilitiesSchema.extend({
  tools: z.array(CurrentOperatorToolNameSchema),
  requirements: z.array(z.object({ name: CurrentOperatorToolNameSchema,
    actions: z.array(ManagementActionSchema), detail: z.string() }).strict()).optional(),
}).strict()
