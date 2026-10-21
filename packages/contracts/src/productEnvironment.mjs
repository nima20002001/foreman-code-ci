/** @typedef {Record<string, string | undefined>} Environment */

/** Compare parsed settings without exposing their values in diagnostics. */
function effectiveValue(suffix, value) {
  if (/(?:TOKEN|SECRET|PASSWORD)$/.test(suffix)) return value
  const trimmed = value.trim()
  if (/(?:PORT|TIMEOUT_MS|SHARDS)$/.test(suffix) && trimmed && Number.isFinite(Number(trimmed))) {
    return String(Number(trimmed))
  }
  if (suffix.endsWith('ORIGIN')) {
    try { return new globalThis.URL(trimmed).toString() } catch { return trimmed }
  }
  if (suffix === 'DEV_OPERATOR_PRINCIPAL_ID') return trimmed
  return value
}

/**
 * Read either spelling of a first-party setting. Validation stays with its consumer.
 * @param {Environment} environment
 * @param {string} suffix
 * @returns {string | undefined}
 */
export function readProductEnvironment(environment, suffix) {
  const canonicalName = `FOREMAN_CODE_${suffix}`
  const legacyName = `GRAPHQL_${suffix}`
  const canonical = environment[canonicalName]
  const legacy = environment[legacyName]
  if (canonical !== undefined && legacy !== undefined
    && effectiveValue(suffix, canonical) !== effectiveValue(suffix, legacy)) {
    throw new Error(`${canonicalName} conflicts with ${legacyName}. Supply one value or matching values.`)
  }
  return canonical ?? legacy
}

/**
 * Canonicalize names after choosing the process or file layer for each logical setting.
 * A process alias overrides either file alias, just as an identical spelling did before.
 * @param {Environment} processEnvironment
 * @param {Environment} [fileEnvironment]
 * @returns {Environment}
 */
export function resolveProductEnvironment(processEnvironment, fileEnvironment = {}) {
  const result = { ...fileEnvironment, ...processEnvironment }
  const suffixes = new Set(Object.keys(result).flatMap(name => {
    const match = /^(?:FOREMAN_CODE|GRAPHQL)_(.+)$/.exec(name)
    return match ? [match[1]] : []
  }))
  for (const suffix of suffixes) {
    const canonicalName = `FOREMAN_CODE_${suffix}`
    const legacyName = `GRAPHQL_${suffix}`
    const hasProcessValue = processEnvironment[canonicalName] !== undefined || processEnvironment[legacyName] !== undefined
    const value = readProductEnvironment(hasProcessValue ? processEnvironment : fileEnvironment, suffix)
    delete result[legacyName]
    result[canonicalName] = value
  }
  return result
}
