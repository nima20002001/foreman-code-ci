/**
 * Applies a session-local sibling order to the ids currently projected by the
 * server. Ids that no longer exist are dropped and newly projected ids keep
 * their natural position after the ordered ones, so a changed list can never
 * lose or hide an entry.
 */
export function applyStoredOrder(
  ids: readonly string[],
  storedOrder: readonly string[] | undefined,
): string[] {
  if (!storedOrder || storedOrder.length === 0) return [...ids]
  const known = new Set(ids)
  const ordered = [...new Set(storedOrder)].filter((id) => known.has(id))
  const orderedSet = new Set(ordered)
  return [...ordered, ...ids.filter((id) => !orderedSet.has(id))]
}

/** Moves `id` to `targetIndex`, clamped to the list bounds. */
export function moveItemToIndex(
  ids: readonly string[],
  id: string,
  targetIndex: number,
): string[] {
  const from = ids.indexOf(id)
  if (from === -1) return [...ids]
  const to = Math.max(0, Math.min(targetIndex, ids.length - 1))
  if (from === to) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/** Moves `id` directly before or after a sibling, within the same list. */
export function moveItemRelative(
  ids: readonly string[],
  id: string,
  targetId: string,
  position: 'before' | 'after',
): string[] {
  if (id === targetId) return [...ids]
  const withoutItem = ids.filter((value) => value !== id)
  const targetIndex = withoutItem.indexOf(targetId)
  if (targetIndex === -1) return [...ids]
  withoutItem.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, id)
  return withoutItem
}
