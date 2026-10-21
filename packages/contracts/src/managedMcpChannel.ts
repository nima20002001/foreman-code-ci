import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { HarnessMcpManagedInputSchema, HarnessMcpReconcileInputSchema, HarnessMcpPlanSchema } from './management/harnessSettings.js'

export const MANAGED_MCP_NAMESPACE = 'managed-mcp-v1'
/** Native management failures carry their public code and message without private error details. */
export const ManagedMcpFailureSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string(), status: z.number().int().min(400).max(599) }).strict(),
}).strict()
const Harness = z.enum(['codex', 'claude'])
export const ManagedMcpRequestSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  request: z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('list'), harness: Harness }).strict(),
    z.object({ operation: z.literal('detect'), harness: Harness }).strict(),
    z.object({ operation: z.literal('apply'), input: HarnessMcpManagedInputSchema, requestedBy: z.string().min(1) }).strict(),
    z.object({ operation: z.literal('reconcile'), input: HarnessMcpReconcileInputSchema, plan: HarnessMcpPlanSchema }).strict(),
  ]),
}).strict()
export type ManagedMcpRequest = z.infer<typeof ManagedMcpRequestSchema>['request']
