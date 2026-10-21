import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from './policy.js'
import { DomainError } from '../errors.js'

/** Filter complete scopes before deciding a page is full or exhausted. */
export async function authorizedPage<T>(input: {
  principal: ManagementPrincipal; action: ManagementAction; cursor?: string | undefined; limit: number
  read: (cursor: string | undefined, limit: number) => Promise<T[]>
  id: (item: T) => string; resource: (item: T) => AuthorizedResource
}) {
  const check = () => {
    if (!hasAction(input.principal, input.action)) throw new DomainError('ACCESS_DENIED', 'The caller is not authorized to list these resources.', 403)
  }
  check()
  const items: T[] = []
  const seen = new Set<string>()
  let cursor = input.cursor
  const batchSize = Math.max(100, input.limit + 1)
  for (;;) {
    const rows = await input.read(cursor, batchSize)
    check()
    for (const row of rows) {
      if (!isAuthorized(input.principal, input.action, input.resource(row))) continue
      if (items.length === input.limit) return { items, pageInfo: { nextCursor: input.id(items.at(-1)!) } }
      items.push(row)
    }
    if (rows.length < batchSize) return { items, pageInfo: { nextCursor: null } }
    const next = input.id(rows.at(-1)!)
    if (next === cursor || seen.has(next)) throw new DomainError('PAGINATION_STALLED', 'The resource cursor did not advance.', 500)
    seen.add(next); cursor = next
  }
}
