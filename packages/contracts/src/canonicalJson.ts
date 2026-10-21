/**
 * The one shared canonical JSON module. Every hash, digest, idempotency key or
 * structural identity built from JSON-shaped values uses one of these
 * serializers; do not add local copies.
 *
 * The canonical format sorts object keys by UTF-16 code unit (Array.prototype.sort
 * order, including integer-like keys such as "10" before "9") at every depth and
 * otherwise follows JSON.stringify. Two serializers emit it:
 *  - canonicalJson: lenient, for JSON values. Object properties whose value is
 *    undefined are omitted, undefined array items become null, and any other
 *    object (Date, Map, class instances) is written from its own enumerable
 *    entries.
 *  - canonicalGraphJson: strict and bounded. It rejects undefined, non-finite
 *    numbers, non-plain objects, cycles, getters and symbol keys, and enforces
 *    byte/depth/node limits. For every value it accepts, its output equals
 *    canonicalJson's.
 *
 * The *Legacy variants are frozen earlier formats that persisted hashes depend
 * on. Never use them for new identities.
 */

/** Lenient canonical JSON: code-unit key order, undefined properties omitted. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Frozen legacy value form (do not use for new identities): a deep copy with
 * keys inserted in code-unit order and undefined properties dropped. Because
 * JavaScript enumerates integer-like keys first, JSON.stringify of this copy
 * writes those keys in ascending numeric order before all other keys. Persisted
 * Operator configuration hashes and Codex plugin/executable identities depend on
 * that order.
 */
export function canonicalJsonValueLegacy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValueLegacy)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => [key, canonicalJsonValueLegacy((value as Record<string, unknown>)[key])]))
}

/** JSON text of canonicalJsonValueLegacy; a top-level undefined yields "null". Frozen legacy format. */
export function canonicalJsonNumericKeysFirstLegacy(value: unknown): string {
  return JSON.stringify(canonicalJsonValueLegacy(value)) ?? 'null'
}

/**
 * Frozen legacy format (do not use for new identities). Keys are ordered with
 * String.prototype.localeCompare, an object property whose value is undefined
 * is written as `"key":undefined`, and an undefined array item is written as an
 * empty slot (`[1,]`). Persisted values that depend on these exact bytes:
 * command receipt input hashes (commandInputHash), source operation selection
 * hashes and resource-telemetry selector keys.
 */
export function canonicalJsonLocaleOrderLegacy(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonLocaleOrderLegacy).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonLocaleOrderLegacy(item)}`).join(',')}}`
  }
  return JSON.stringify(value) as string
}

/** Canonical, bounded COMPLETE JSON. Never evaluates text or emits a truncated prefix. */
export function canonicalGraphJson(value: unknown, maxBytes = 8 * 1024 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('GRAPH_JSON_LIMIT')
  const seen = new Set<object>(), pieces: string[] = []
  let visited = 0, bytes = 0
  const push = (text: string) => {
    bytes += utf8ByteLength(text)
    if (bytes > maxBytes) throw new Error('GRAPH_JSON_LIMIT')
    pieces.push(text)
  }
  const string = (text: string) => {
    // Each UTF-16 code unit needs at least one byte in its JSON representation.
    if (text.length > maxBytes - bytes) throw new Error('GRAPH_JSON_LIMIT')
    push(JSON.stringify(text))
  }
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32 || ++visited > 100_000) throw new Error('GRAPH_JSON_LIMIT')
    if (item === null) { push('null'); return }
    if (typeof item === 'string') { string(item); return }
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) { push(JSON.stringify(item)); return }
    if (typeof item !== 'object' || !item || seen.has(item)) throw new Error('GRAPH_JSON_INVALID')
    if (Object.getOwnPropertySymbols(item).length) throw new Error('GRAPH_JSON_INVALID')
    seen.add(item)
    if (Array.isArray(item)) {
      if (item.length > 100_000 - visited) throw new Error('GRAPH_JSON_LIMIT')
      // No holes, getters, hidden values or non-index fields silently omitted.
      if (Object.keys(item).length !== item.length || Object.getOwnPropertyNames(item).length !== item.length + 1) throw new Error('GRAPH_JSON_INVALID')
      push('[')
      for (let i = 0; i < item.length; i++) {
        if (i) push(',')
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
        if (!descriptor || !('value' in descriptor)) throw new Error('GRAPH_JSON_INVALID')
        visit(descriptor.value, depth + 1)
      }
      push(']')
    } else {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('GRAPH_JSON_INVALID')
      const keys = Object.keys(item).sort()
      if (keys.length > 100_000 - visited) throw new Error('GRAPH_JSON_LIMIT')
      if (Object.getOwnPropertyNames(item).length !== keys.length) throw new Error('GRAPH_JSON_INVALID')
      push('{')
      keys.forEach((key, index) => {
        if (index) push(',')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !('value' in descriptor)) throw new Error('GRAPH_JSON_INVALID')
        string(key); push(':'); visit(descriptor.value, depth + 1)
      })
      push('}')
    }
    seen.delete(item)
  }
  visit(value, 0)
  return pieces.join('')
}

/** Counts UTF-8 bytes without allocating an encoded copy of each JSON fragment. */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}
