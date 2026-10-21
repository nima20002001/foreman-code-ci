export function endpointMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  try {
    const left = new URL(actual)
    const right = new URL(expected)
    return !left.username && !left.password && !right.username && !right.password
      && (left.protocol === 'http:' || left.protocol === 'https:')
      && left.protocol === right.protocol && left.host === right.host
      && left.pathname === right.pathname && left.search === right.search && left.hash === right.hash
  } catch { return false }
}
