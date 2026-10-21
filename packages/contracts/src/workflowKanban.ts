import { z } from 'zod';
import { IdSchema } from './schemaPrimitives.js';

/** Where the workflow's memory board (the Kanban) sits on that workflow's Board canvas, in canvas
 * coordinates. Board layout only: hiding it never changes the memory board or its cards. */
export const WorkflowKanbanFrameSchema = z.object({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  width: z.number().finite().min(240).max(4000),
  height: z.number().finite().min(160).max(4000),
}).strict();
/** frame null means the Board places it beside the Agents the first time it is shown. */
export const WorkflowKanbanLayoutSchema = z.object({
  visible: z.boolean(),
  frame: WorkflowKanbanFrameSchema.nullable(),
}).strict();
export const WorkflowKanbanScopeSchema = z.object({ workspaceId: IdSchema, workflowId: IdSchema }).strict();
export const WorkflowKanbanLayoutReadSchema = WorkflowKanbanScopeSchema.extend({
  layout: WorkflowKanbanLayoutSchema,
}).strict();
export const WorkflowKanbanLayoutSetInputSchema = WorkflowKanbanScopeSchema.extend({
  layout: WorkflowKanbanLayoutSchema,
}).strict();

export const WORKFLOW_KANBAN_LAYOUT_ROUTE = '/api/management/workspaces/:workspaceId/workflows/:workflowId/kanban-layout';
export const DEFAULT_WORKFLOW_KANBAN_LAYOUT = { visible: false, frame: null } as const;

export type WorkflowKanbanFrame = z.infer<typeof WorkflowKanbanFrameSchema>;
export type WorkflowKanbanLayout = z.infer<typeof WorkflowKanbanLayoutSchema>;
export type WorkflowKanbanLayoutRead = z.infer<typeof WorkflowKanbanLayoutReadSchema>;
export type WorkflowKanbanLayoutSetInput = z.infer<typeof WorkflowKanbanLayoutSetInputSchema>;
