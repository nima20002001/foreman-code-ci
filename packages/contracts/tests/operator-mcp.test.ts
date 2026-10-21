import { describe, expect, it } from 'vitest'
import {
  decodeMcpToolResult,
  mcpInputSchema,
  OperatorAgentListInputSchema,
  OperatorRunListInputSchema,
  OperatorToolSchemaInputSchema,
  OperatorWorkflowListInputSchema,
  OperatorWorkspaceListInputSchema,
} from '../src/operatorMcp.js'
import {
  AgentListInputSchema,
  RunListInputSchema,
  WorkflowListInputSchema,
  WorkspaceListInputSchema,
} from '../src/management/index.js'

const lists = [
  { name: 'workspace', operator: OperatorWorkspaceListInputSchema, domain: WorkspaceListInputSchema, input: {} },
  { name: 'workflow', operator: OperatorWorkflowListInputSchema, domain: WorkflowListInputSchema,
    input: { workspaceId: 'workspace' } },
  { name: 'agent', operator: OperatorAgentListInputSchema, domain: AgentListInputSchema,
    input: { workspaceId: 'workspace', workflowId: 'workflow' } },
  { name: 'run', operator: OperatorRunListInputSchema, domain: RunListInputSchema,
    input: { workspaceId: 'workspace', workflowId: 'workflow' } },
]

describe('Operator list inputs', () => {
  it.each(lists)('defaults $name pages to ten without changing domain defaults', ({ operator, domain, input }) => {
    expect(operator.parse(input)).toMatchObject({ ...input, limit: 10 })
    expect(domain.parse(input)).toMatchObject({ ...input, limit: 50 })
  })

  it.each(lists)('preserves explicit $name limits and cursors', ({ operator, input }) => {
    for (const limit of [1, 50, 100]) {
      expect(operator.parse({ ...input, limit, cursor: 'next-page' }))
        .toMatchObject({ ...input, limit, cursor: 'next-page' })
    }
    for (const limit of [0, -1, 1.5, 101]) {
      expect(operator.safeParse({ ...input, limit }).success).toBe(false)
    }
  })

  it('keeps archive filters and requires explicit full workspace and workflow views', () => {
    for (const { operator, input } of lists.slice(0, 2)) {
      expect(operator.parse(input)).toMatchObject({ detail: 'compact', includeArchived: false })
      expect(operator.parse({ ...input, detail: 'full', includeArchived: true }))
        .toMatchObject({ detail: 'full', includeArchived: true })
      expect(operator.safeParse({ ...input, detail: 'unknown' }).success).toBe(false)
    }
    expect(OperatorAgentListInputSchema.parse({ workspaceId: 'workspace', includeArchived: true }))
      .toMatchObject({ includeArchived: true })
  })
})

describe('MCP result decoding', () => {
  it('prefers structured results and reads JSON text while preserving nested values', () => {
    const value = { revision: 2, nested: { nullable: null, enabled: false, items: [1, 2] } }
    expect(decodeMcpToolResult({ structuredContent: value,
      content: [{ type: 'text', text: 'Distinct instructions.' }] })).toEqual(value)
    expect(decodeMcpToolResult({ content: [
      { type: 'image' }, { type: 'text', text: JSON.stringify(value) },
      { type: 'text', text: 'Distinct instructions.' },
    ] })).toEqual(value)
  })

  it('reads wrapped primitive data and actionable JSON errors', () => {
    for (const value of [null, false, [1, 2]]) {
      expect(decodeMcpToolResult({ content: [{ type: 'text', text: JSON.stringify({ value }) }] }))
        .toEqual({ value })
    }
    const error = { error: { code: 'REVISION_CONFLICT', message: 'Changed.', details: { revision: 3 } } }
    expect(decodeMcpToolResult({ content: [{ type: 'text', text: JSON.stringify(error) }] })).toEqual(error)
  })

  it('rejects missing and malformed JSON data', () => {
    expect(() => decodeMcpToolResult({ content: [] })).toThrow('no JSON data')
    expect(() => decodeMcpToolResult({ content: [{ type: 'text', text: 'invalid' }] })).toThrow(SyntaxError)
  })
})

describe('Operator schema lookup input', () => {
  it('requests output schemas explicitly and bounds the selected name', () => {
    expect(OperatorToolSchemaInputSchema.parse({ name: 'workspace_update' }))
      .toEqual({ name: 'workspace_update', includeOutputSchema: false })
    expect(OperatorToolSchemaInputSchema.parse({ name: 'workspace_update', includeOutputSchema: true }))
      .toEqual({ name: 'workspace_update', includeOutputSchema: true })
    for (const name of ['', 'x'.repeat(257)]) {
      expect(OperatorToolSchemaInputSchema.safeParse({ name }).success).toBe(false)
    }
    expect(mcpInputSchema(OperatorToolSchemaInputSchema).parse({ name: 'workspace_update', unknown: true }))
      .toEqual({ name: 'workspace_update', includeOutputSchema: false })
  })
})
