/** Short display identity; extend the prefix when another identity would collide. */
export function compactIdentity(value: string, identities: readonly string[]): string {
  if (value.length <= 20) return value
  let width = 8
  while (width < value.length && identities.some(other => other !== value && other.startsWith(value.slice(0, width)))) width += 1
  return width < value.length ? `${value.slice(0, width)}…` : value
}
