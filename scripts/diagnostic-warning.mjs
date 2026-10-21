const failures = new Map()

/** Scripts report bounded codes, never command output or credentials. */
export function diagnosticWarning(operation, error, fallbackCode = 'OPERATION_FAILED') {
  let code = fallbackCode
  if (typeof error?.code === 'string') code = error.code
  else if (typeof error?.cause?.code === 'string') code = error.cause.code
  else if (error?.name === 'TimeoutError') code = 'TIMEOUT'
  const lastError = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(code) ? code : fallbackCode
  const failureCount = (failures.get(operation) ?? 0) + 1
  failures.set(operation, failureCount)
  console.warn(JSON.stringify({ operation, status: 'degraded', code: fallbackCode, lastError, failureCount,
    failedAt: new Date().toISOString() }))
}
