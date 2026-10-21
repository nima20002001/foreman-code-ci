export interface ManagementPage<T> {
  items: T[]
  pageInfo: { nextCursor: string | null }
}

/** Never present a truncated first page as a complete management catalog. */
export async function collectManagementPages<T>(
  read: (cursor?: string) => Promise<ManagementPage<T>>,
  signal?: AbortSignal,
): Promise<ManagementPage<T>> {
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    signal?.throwIfAborted()
    const page = await read(cursor)
    signal?.throwIfAborted()
    items.push(...page.items)
    const next = page.pageInfo.nextCursor
    if (next === null) return { items, pageInfo: { nextCursor: null } }
    if (!next || seen.has(next)) throw new Error('The catalog returned a repeated or invalid pagination cursor. Reload and retry.')
    seen.add(next)
    cursor = next
  }
}

export function managementPageUrl(path: string, cursor?: string, limit = 100): string {
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor !== undefined) query.set('cursor', cursor)
  return `${path}${path.includes('?') ? '&' : '?'}${query}`
}
