import { describe, expect, it } from 'vitest'
import { WorkflowReorderInputSchema, WorkflowReorderResultSchema } from '../src/management/index.js'
import { SavedManagedWorkflowPageSchema } from '../src/wave25/saved.js'
import { CurrentManagedWorkflowPageSchema } from '../src/wave25/currentRead.js'
import { WorkflowSummaryPageSchema } from '../src/operatorMcp.js'

describe('workflow order contracts', () => {
  const input = {
    workspaceId: 'workspace-a', commandId: 'command-reorder', expectedRevision: 7,
    workflowIds: ['workflow-b', 'workflow-a'],
  }

  it('requires a unique ordered subset and its own revision', () => {
    expect(WorkflowReorderInputSchema.parse(input)).toEqual(input)
    for (const workflowIds of [[], ['workflow-a'], ['workflow-a', 'workflow-a']]) {
      expect(WorkflowReorderInputSchema.safeParse({ ...input, workflowIds }).success).toBe(false)
    }
    expect(WorkflowReorderInputSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false)
    expect(WorkflowReorderInputSchema.safeParse({ ...input, workflowId: 'workflow-a' }).success).toBe(false)
    expect(WorkflowReorderInputSchema.safeParse({
      ...input, workflowIds: Array.from({ length: 101 }, (_, index) => `workflow-${index}`),
    }).success).toBe(true)
    expect(WorkflowReorderResultSchema.parse({
      value: { workspaceId: input.workspaceId, workflowIds: input.workflowIds, orderRevision: 8 }, replayed: false,
    }).value.orderRevision).toBe(8)
  })

  it('carries the order revision through full and compact pages and accepts existing empty fixtures', () => {
    const page = { items: [], pageInfo: { nextCursor: null } }
    for (const schema of [SavedManagedWorkflowPageSchema, CurrentManagedWorkflowPageSchema]) {
      expect(schema.parse(page).orderRevision).toBe(0)
      expect(schema.parse({ ...page, orderRevision: 9 }).orderRevision).toBe(9)
    }
    expect(WorkflowSummaryPageSchema.parse({ ...page, detail: 'compact', orderRevision: 9 }).orderRevision).toBe(9)
  })
})
