import { createHash } from 'node:crypto'
import { DomainError } from '../errors.js'

interface WorkflowScope { workspaceId: string; workflowId?: string | undefined }
export interface RunHistoryBoundary { admittedAt: string; runId: string }
const MAX_CURSOR_BYTES = 16_384
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
function scopeHash(scope: WorkflowScope): string {
  return createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.workflowId])).digest('hex')
}
function invalid(): never {
  throw new DomainError('RUN_HISTORY_CURSOR_INVALID', 'Use a Run history cursor from the same workspace and workflow filter.', 400)
}
function validTimestamp(value: string): boolean {
  if (!TIMESTAMP.test(value) || value.startsWith('0000-')) return false
  const milliseconds = value.slice(0, 23) + 'Z'
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds
}
/** Preserve PostgreSQL microseconds. Going through a JS Date would skip rows
 * when multiple admissions share a millisecond. The Run-id tie-breaker uses C
 * collation in SQL; this cursor is a position, never an authorization grant. */
export function encodeRunHistoryCursor(scope: WorkflowScope, boundary: RunHistoryBoundary): string {
  if (!validTimestamp(boundary.admittedAt) || !boundary.runId || boundary.runId.trim() !== boundary.runId || boundary.runId.includes('\0')) return invalid()
  const value = Buffer.from(JSON.stringify([1, scopeHash(scope), boundary.admittedAt, boundary.runId])).toString('base64url')
  if (value.length > MAX_CURSOR_BYTES) return invalid()
  return value
}
export function decodeRunHistoryCursor(scope: WorkflowScope, value?: string): RunHistoryBoundary | undefined {
  if (value === undefined) return undefined
  if (value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid()
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) return invalid()
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(raw) || raw.length !== 4 || raw[0] !== 1 || raw[1] !== scopeHash(scope)
      || typeof raw[2] !== 'string' || !validTimestamp(raw[2])
      || typeof raw[3] !== 'string' || !raw[3] || raw[3].trim() !== raw[3] || raw[3].includes('\0')) return invalid()
    const boundary = { admittedAt: raw[2], runId: raw[3] }
    if (encodeRunHistoryCursor(scope, boundary) !== value) return invalid()
    return boundary
  } catch { return invalid() }
}
