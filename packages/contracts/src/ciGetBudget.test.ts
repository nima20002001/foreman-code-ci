import { expect, it } from 'vitest'
import { CiGetInputSchema, OperatorCiGetInputSchema } from './ci.js'

it.each([CiGetInputSchema, OperatorCiGetInputSchema])(
  'accepts the full group-wait budget for each MCP role', schema => {
    const scope = schema === OperatorCiGetInputSchema ? { workspaceId: 'workspace' } : {}
    const input = { ...scope, ticketId: 'ticket', waitUntil: 'group-terminal', logTail: false }
    for (const waitSeconds of [0, 0.1, 60, 300, 1800]) {
      expect(schema.safeParse({ ...input, waitSeconds }).success).toBe(true)
    }
    for (const waitSeconds of [-1, 1800.1, '1800']) {
      expect(schema.safeParse({ ...input, waitSeconds }).success).toBe(false)
    }
  },
)
