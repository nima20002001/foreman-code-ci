import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appMcpDirectory } from '@foreman-code/contracts/product-environment-node'
import { accessSync, constants } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'

export function isDatabaseCredentialVariable(key: string): boolean {
  return key === 'DATABASE_URL' || key.endsWith('_DATABASE_URL') || key === 'PGPASSWORD'
    || key === 'GRAPHQL_PRODUCTION_DB_PASSWORD' || key === 'FOREMAN_CODE_PRODUCTION_DB_PASSWORD'
}

export function isControllerEnvironmentVariable(key: string): boolean {
  return key === 'NODE_OPTIONS' || key.startsWith('OPERATOR_')
    || /^(?:GRAPHQL|FOREMAN_CODE)_(?:OPERATOR|APP|TEST)_/.test(key)
    || (APP_MCP_TOKEN_NAMES as readonly string[]).includes(key)
    || key.endsWith('DATABASE_URL') || isDatabaseCredentialVariable(key)
}

/** Deliberate application-secret delivery boundary, not a host sandbox. */
export function inheritedAgentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, NO_COLOR: '1' }
  for (const key of Object.keys(environment)) {
    if (isControllerEnvironmentVariable(key)) delete environment[key]
  }
  return environment
}

/** Deliver the admitted token in both native spellings together with its bridge location. */
export function appMcpTokenEnvironment(source: NodeJS.ProcessEnv, runtimeEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = readProductEnvironment(source, 'MCP_TOKEN')
  if (token === undefined) return source
  return { ...source, FOREMAN_CODE_MCP_TOKEN: token, GRAPHQL_MCP_TOKEN: token,
    FOREMAN_CODE_APP_MCP_DIRECTORY: appMcpDirectory(runtimeEnvironment) }
}

/** Keep a native CLI's helper lookups on the same installation as its executable. */
export function nativeAgentEnvironment(binary: string, cwd: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Callers have already applied their own credential policy and may have added
  // a scoped Agent token. Only PATH changes at the process boundary.
  const environment = { ...source }
  const paths = (environment.PATH ?? '').split(delimiter).filter((entry) =>
    entry && !/(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/i.test(entry))
  let directory: string | undefined
  if (binary.includes('/') || binary.includes('\\')) directory = dirname(resolve(cwd, binary))
  else {
    const entry = paths.find((candidate) => {
      try { accessSync(resolve(cwd, candidate, binary), constants.X_OK); return true } catch { return false }
    })
    if (entry) directory = resolve(cwd, entry)
  }
  environment.PATH = [...new Set(directory ? [directory, ...paths] : paths)].join(delimiter)
  return environment
}

function preparedSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length > 0))].sort((left, right) => right.length - left.length)
}

function redactPreparedText(value: string, values: readonly string[]): string {
  if (!values.length) return value
  const replace = (text: string) => values.reduce((current, secret) =>
    current.includes(secret) ? current.split(secret).join('[REDACTED]') : current, text)
  // Providers sometimes embed JSON in raw stdout/stderr, including arrays and
  // Unicode-escaped string literals. Decode individual JSON strings before
  // matching known values; do not rely on the surrounding field name.
  let result = value.includes('\\') && value.includes('"') ? value.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
    try {
      const decoded: unknown = JSON.parse(quoted)
      if (typeof decoded !== 'string') return quoted
      const safe = replace(decoded)
      return safe === decoded ? quoted : JSON.stringify(safe)
    } catch { return quoted }
  }) : value
  result = replace(result)
  return result
}

export function redactSecretText(value: string, secrets: readonly string[]): string {
  return redactPreparedText(value, preparedSecrets(secrets))
}

/** Redact values and keys after JSON decoding, including escaped JSON strings. */
export function redactKnownSecrets<T>(value: T, secrets: readonly string[]): T {
  const values = preparedSecrets(secrets)
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactPreparedText(item, values)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [
        redactPreparedText(key, values), visit(nested),
      ]))
    }
    return item
  }
  return visit(value) as T
}
