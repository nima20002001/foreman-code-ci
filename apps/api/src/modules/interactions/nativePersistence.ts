import { DomainError } from '../errors.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { redactSecretText } from '../harnesses/secrets.js'

// AccessService issues opm_ + 32 random base64url bytes (43 characters).
// Cold history can contain a previous process token whose plaintext is no longer
// available locally. Mask that exact credential format as well as owned values.
const appToken = /opm_[A-Za-z0-9_-]{43}/g

/** Capture process-owned values before cleanup can release the credential map. */
export function nativePersistenceRedactor(secrets: readonly string[]) {
  const knownSecrets = [...new Set(secrets)]
  const text = (input: string): string => {
    const safe = redactSecretText(input, knownSecrets)
    return safe.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
      try {
        const decoded: unknown = JSON.parse(quoted)
        if (typeof decoded !== 'string') return quoted
        const masked = decoded.replace(appToken, '[REDACTED]')
        return masked === decoded ? quoted : JSON.stringify(masked)
      } catch { return quoted }
    }).replace(appToken, '[REDACTED]')
  }
  const value = <T>(input: T): T => {
    if (typeof input === 'string') return text(input) as T
    if (Array.isArray(input)) return input.map((item: unknown) => value(item)) as T
    if (input && typeof input === 'object') return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [text(key), value(item)]),
    ) as T
    return input
  }
  const error = (input: unknown): unknown => {
    if (input instanceof AggregateError) return new AggregateError([...input.errors].map(error), text(input.message))
    if (input instanceof DomainError) {
      const sanitized = new DomainError(text(input.code), text(input.message), input.status, value(input.details))
      if (input.cause !== undefined) sanitized.cause = error(input.cause)
      return sanitized
    }
    if (input instanceof HarnessExecutionError) return new HarnessExecutionError(
      text(input.result.error?.code ?? 'NATIVE_EXECUTION_FAILED'), text(input.message), input.result.error?.retryable,
      input.cause === undefined ? undefined : { cause: error(input.cause) },
    )
    // Do not forward a raw provider stack or enumerable environment/error fields.
    if (input instanceof Error) {
      const sanitized = input.cause === undefined ? new Error(text(input.message))
        : new Error(text(input.message), { cause: error(input.cause) })
      const { code, retryable } = input as Error & { code?: unknown; retryable?: unknown }
      if (typeof code === 'string') Object.assign(sanitized, { code: text(code) })
      else if (typeof code === 'number') Object.assign(sanitized, { code })
      if (typeof retryable === 'boolean') Object.assign(sanitized, { retryable })
      return sanitized
    }
    return value(input)
  }
  return { value, text, error }
}

export type NativePersistenceRedactor = ReturnType<typeof nativePersistenceRedactor>
