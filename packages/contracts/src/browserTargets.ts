import { z } from 'zod';
import { AgentSubjectSchema } from './agentIdentity.js';
import { NodeBrowserSettingsSchema } from './browserProfiles.js';
import { BrowserPrepareResultSchema } from './browserSessions.js';
import { BrowserLifecyclePrepareSchema } from './browserTransport.js';
import { WorkflowExecutionChatSelectionSchema, WorkflowExecutionChatResolutionSchema } from './workflowExecutionChat.js';
import { IdSchema } from './schemaPrimitives.js';

export const BrowserTargetSelectionSchema = WorkflowExecutionChatSelectionSchema;
export const BrowserTargetResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selected'), subject: AgentSubjectSchema, browser: NodeBrowserSettingsSchema,
    computerId: IdSchema, historical: z.boolean(), readOnly: z.boolean(),
    preparation: z.object({ request: BrowserLifecyclePrepareSchema, result: BrowserPrepareResultSchema }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal('choose_target'), selection: WorkflowExecutionChatResolutionSchema }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['conversation_missing', 'consultation_idle', 'node_unavailable']) }).strict(),
]);
export type BrowserTargetResult = z.infer<typeof BrowserTargetResultSchema>;
