import { z } from 'zod'
import { WorkerConversationBindingSchema } from './workerConversations.js'

const fields = { version: z.literal(1), binding: WorkerConversationBindingSchema,
  token: z.string().min(1).max(16384), admissionId: z.uuid().optional() }
export const WorkerConversationMcpRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...fields, operation: z.literal('conversation-mcp.authorize') }).strict(),
  z.object({ ...fields, operation: z.literal('conversation-mcp.request'), body: z.json(),
    protocolVersion: z.string().max(64).optional() }).strict(),
]).superRefine((value, context) => {
  if (value.binding.appMcpAccess !== 'scoped'
    || value.binding.owner.kind === 'agent' && !value.admissionId) {
    context.addIssue({ code: 'custom', message: 'MCP requires a scoped conversation and an admitted Agent binding.' })
  }
})
export type WorkerConversationMcpRequest = z.infer<typeof WorkerConversationMcpRequestSchema>
export const WorkerConversationMcpAuthorizationSchema = z.object({ expiresAt: z.iso.datetime() }).strict()
