import { z } from 'zod'
import { DomainError } from '../errors.js'
import { invalid } from './identity.js'
import type { Page } from './types.js'

const Cursor = z.object({ key: z.string(), revision: z.number().int().nonnegative(),
  last: z.tuple([z.union([z.string(),z.number()]),z.string()]) }).strict()
type CursorValue = z.infer<typeof Cursor>
export function decodeCursor(cursor: string | undefined, key: string, revision: number): CursorValue | undefined {
  if (!cursor) return undefined
  let parsed: CursorValue
  try { parsed = Cursor.parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'))) }
  catch { invalid('This page cursor is invalid.') }
  if (parsed.key !== key) invalid('This page cursor belongs to a different filter.')
  if (parsed.revision !== revision) throw new DomainError('CURSOR_STALE',
    'The board changed. Read the first page for this filter again.',409,{ resetRequired: true })
  return parsed
}
export function page<T>(items: T[], limit: number, revision: number, key: string,
  last: (item: T) => CursorValue['last']): Page<T> {
  const hasMore = items.length > limit
  const visible = items.slice(0,limit)
  return { items: visible, revision, hasMore,
    nextCursor: hasMore && visible.length ? Buffer.from(JSON.stringify({ key,revision,last:last(visible[visible.length-1]!) })).toString('base64url') : null }
}
