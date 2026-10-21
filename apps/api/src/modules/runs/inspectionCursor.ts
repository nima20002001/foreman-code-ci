import { createHash } from 'node:crypto'
import { DomainError } from '../errors.js'

export interface ExecutionPagePosition { createdAt: string; executionId: string }
type Kind = 'executions' | 'bindings'
const invalid = () => new DomainError('RUN_INSPECTION_CURSOR_INVALID', 'The cursor is invalid for this exact inspection scope and filters.', 400)
const key = (scope: readonly unknown[]) => createHash('sha256').update(JSON.stringify(scope)).digest('hex')
function encode(kind: Kind, scope: readonly unknown[], position: unknown): string {
  return Buffer.from(JSON.stringify({ version: 1, kind, scope: key(scope), position }), 'utf8').toString('base64url')
}
function decode(kind: Kind, scope: readonly unknown[], cursor: string): unknown {
  if (!cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid()
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw invalid()
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'kind,position,scope,version'
      || record.version !== 1 || record.kind !== kind || record.scope !== key(scope)) throw invalid()
    return record.position
  } catch { throw invalid() }
}
export function encodeExecutionPageCursor(scope: readonly unknown[], position: ExecutionPagePosition): string {
  return encode('executions', scope, position)
}
export function decodeExecutionPageCursor(scope: readonly unknown[], cursor: string | undefined): ExecutionPagePosition | undefined {
  if (cursor === undefined) return undefined
  const value = decode('executions', scope, cursor)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const position = value as Record<string, unknown>
  if (Object.keys(position).sort().join(',') !== 'createdAt,executionId'
    || typeof position.createdAt !== 'string' || typeof position.executionId !== 'string'
    || !position.executionId || position.executionId.length > 1000 || position.executionId.includes('\0')) throw invalid()
  // Keep PostgreSQL's microseconds as text, never round the paging key through a JS Date.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(position.createdAt)
  const date = new Date(position.createdAt)
  if (!match || Number(match[1]) < 1 || !Number.isFinite(date.getTime())
    || date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3]) || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5]) || date.getUTCSeconds() !== Number(match[6])) throw invalid()
  return { createdAt: position.createdAt, executionId: position.executionId }
}
export function encodeBindingPageCursor(scope: readonly unknown[], ordinal: number): string {
  return encode('bindings', scope, ordinal)
}
export function decodeBindingPageCursor(scope: readonly unknown[], cursor: string | undefined): number {
  if (cursor === undefined) return -1
  const value = decode('bindings', scope, cursor)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 16000) throw invalid()
  return value
}
