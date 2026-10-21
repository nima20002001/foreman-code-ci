import { expect, it } from 'vitest'
import { OperatorRunGetInputSchema, OperatorSourceListInputSchema } from './operatorMcp.js'

it('defaults Operator reads to compact detail and bounds source pages', () => {
  expect(OperatorRunGetInputSchema.parse({ workspaceId: 'workspace', runId: 'run' }).detail).toBe('compact')
  expect(OperatorSourceListInputSchema.parse({ workspaceId: 'workspace' })).toMatchObject({ detail: 'compact', limit: 10 })
  expect(OperatorSourceListInputSchema.safeParse({ workspaceId: 'workspace', limit: 101 }).success).toBe(false)
})
