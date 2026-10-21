import {
  AppInteractionGetInputSchema,
  AppInteractionGetOutputSchema,
  AppInteractionListOutputSchema,
  AppInteractionRespondOutputSchema,
  AgentProductRoleSchema,
  GraphqlAgentToolSchema,
  RespondToInteractionRequestSchema,
  IdSchema,
} from '@foreman-code/contracts'
import { z } from 'zod'
import { AppInteractionListInputSchema } from '../../modules/interactions/app.js'

export const AppContextSchema = z.object({
  principal: z.object({
    id: IdSchema,
    audience: z.literal('worker'),
    agentId: IdSchema,
    expiresAt: z.iso.datetime(),
  }).strict(),
  role: AgentProductRoleSchema,
  /** Foreman Code MCP tools enabled for this Agent's configuration and workflow node. */
  tools: z.array(GraphqlAgentToolSchema),
  scope: z.object({
    workspaceIds: z.array(IdSchema).optional(),
    workflowIds: z.array(IdSchema).optional(),
    runIds: z.array(IdSchema).optional(),
  }).strict(),
  capabilities: z.object({
    contextGet: z.literal(true),
    bugReport: z.boolean(),
    interactionList: z.boolean(),
    interactionGet: z.boolean(),
    interactionRespond: z.boolean(),
  }).strict(),
  /** This Agent's own git worktree and branch of the workspace repository, when the workspace has one. */
  worktree: z.object({ repository: z.string(), branch: z.string(), baseCommit: z.string(), path: z.string() }).strict().optional(),
  /** Local synced workspace files; harness writable-directory settings still apply. */
  sharedFiles: z.object({ provider: z.literal('syncthing'), path: z.string() }).strict().optional(),
}).strict()

export const InteractionGetInputSchema = AppInteractionGetInputSchema
export const InteractionGetOutputSchema = AppInteractionGetOutputSchema
const ListInteractionsResponseSchema = AppInteractionListOutputSchema
const RespondToInteractionResponseSchema = AppInteractionRespondOutputSchema

export {
  AppInteractionListInputSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
}
