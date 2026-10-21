import { z } from 'zod'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

interface WorkflowListScope {
  workspaceId: string
  includeArchived: boolean
  workflowIds: string[] | null
}
const CursorSchema = z.tuple([
  z.literal(1), z.string(), z.number().int().nonnegative(),
  z.string().regex(/^[1-9]\d{0,18}$/).refine((value) => BigInt(value) <= 9223372036854775807n),
])

function invalidCursor(): never {
  throw new DomainError('WORKFLOW_ORDER_CURSOR_INVALID',
    'Use a workflow list cursor from the same workspace, filter and access scope.', 400)
}

export function encodeWorkflowOrderCursor(scope: WorkflowListScope, orderRevision: number, position: string): string {
  const value = CursorSchema.parse([1, commandInputHash(scope), orderRevision, position])
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function decodeWorkflowOrderCursor(scope: WorkflowListScope, cursor?: string) {
  if (cursor === undefined) return undefined
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalidCursor()
  const bytes = Buffer.from(cursor, 'base64url')
  if (bytes.toString('base64url') !== cursor) return invalidCursor()
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) return invalidCursor()
    throw error
  }
  const parsed = CursorSchema.safeParse(raw)
  if (!parsed.success || parsed.data[1] !== commandInputHash(scope)) return invalidCursor()
  return { orderRevision: parsed.data[2], position: parsed.data[3] }
}
