import { z } from 'zod'

/** Decimal strings preserve PostgreSQL bigint identities without rounding. */
export const RunLiveSequenceSchema = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807', 'Invalid activity sequence')
const RunNodeActionKindSchema = z.enum([
  'reading_file', 'writing_file', 'listing_files', 'searching_files', 'creating_folder',
  'using_app_mcp', 'using_operator_mcp', 'using_mcp', 'running_command',
  'spawning_subagent', 'using_subagent', 'searching_web', 'reviewing_request',
  'responding_approval', 'waiting_approval', 'waiting_delivery', 'waiting_review', 'checking_review',
])
export type RunNodeActionKind = z.infer<typeof RunNodeActionKindSchema>

/** Only the backend creates labels. Native arguments, paths and prose are not part of this contract. */
export const RunNodeLiveActivitySchema = z.object({
  workflowNodeId: z.string().min(1),
  agentId: z.string().min(1),
  state: z.enum(['working', 'waiting', 'idle']),
  action: z.object({ kind: RunNodeActionKindSchema, label: z.string().min(1).max(180) }).strict().nullable(),
  event: z.object({ id: z.string().min(1), sequence: RunLiveSequenceSchema }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.state !== 'idle' && value.event === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event'], message: 'Live node state requires a persisted event identity.' })
  }
  if (value.state === 'idle' && value.action !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['action'], message: 'Idle nodes cannot have a live action.' })
  }
})
export type RunNodeLiveActivity = z.infer<typeof RunNodeLiveActivitySchema>

export const RunLiveActivitySchema = z.object({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowVersionId: z.string().min(1),
  active: z.boolean(),
  sequence: RunLiveSequenceSchema,
  /** Detect a lower-sequence transaction that committed after the previous read. */
  eventCount: RunLiveSequenceSchema,
  nodes: z.array(RunNodeLiveActivitySchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>()
  value.nodes.forEach((node, index) => {
    if (seen.has(node.workflowNodeId)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['nodes', index, 'workflowNodeId'], message: 'Each workflow node has one live state.' })
    seen.add(node.workflowNodeId)
    if (!value.active && node.state !== 'idle') context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['nodes', index, 'state'], message: 'Inactive Runs cannot have live node activity.' })
  })
})
export type RunLiveActivity = z.infer<typeof RunLiveActivitySchema>
