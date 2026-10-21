import { isRecord } from '../../../shared/records.js'
import { errorMessage } from '../../../shared/errorMessage.js'
import { CODEX_RESPONSE_FIELDS, protocolFromBundle } from '../codexProtocolBundle.js'
import { CompatibilityCheckError } from './errors.js'

type ObjectValue = Record<string, unknown>
const invalid = (contract = 'protocol and settings') => new CompatibilityCheckError('PROTOCOL_SETTINGS_UNSUPPORTED',
  `Required contract is unavailable: ${contract}.`)
function object(value: unknown): ObjectValue {
  if (!isRecord(value)) throw invalid()
  return value as ObjectValue
}
/** Local refs only; never fetch a schema, follow external refs, or execute sample requests. */
function resolve(document: ObjectValue, value: unknown, depth = 0): ObjectValue {
  const schema = object(value)
  if (depth > 40) throw invalid()
  if (schema.$ref === undefined) return schema
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) throw invalid()
  let current: unknown = document
  for (const token of schema.$ref.slice(2).split('/')) {
    const name = token.replace(/~1/g, '/').replace(/~0/g, '~')
    const parent = object(current)
    if (!Object.hasOwn(parent, name)) throw invalid(`schema reference ${name}`)
    current = parent[name]
  }
  return resolve(document, current, depth + 1)
}
function properties(document: ObjectValue, value: unknown): ObjectValue {
  return object(resolve(document, value).properties)
}
function fields(value: ObjectValue, names: readonly string[]): void {
  for (const name of names) if (!Object.hasOwn(value, name) || !value[name] || typeof value[name] !== 'object') throw invalid(`field ${name}`)
}
function supportsEnum(document: ObjectValue, value: unknown, expected: readonly string[], depth = 0): void {
  if (depth > 40) throw invalid()
  const schema = resolve(document, value)
  const choices = Array.isArray(schema.enum) ? schema.enum : []
  if (expected.every((item) => choices.includes(item))) return
  for (const choice of [...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []), ...(Array.isArray(schema.allOf) ? schema.allOf : [])]) {
    try { supportsEnum(document, choice, expected, depth + 1); return } catch { /* ignore: try another declared branch. */ }
  }
  throw invalid(`enum values ${expected.join(', ')}`)
}
function supportsType(document: ObjectValue, value: unknown, expected: string, depth = 0): void {
  if (depth > 40) throw invalid()
  const schema = resolve(document, value)
  if (schema.type === expected || (Array.isArray(schema.type) && schema.type.includes(expected))) return
  for (const choice of [...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []), ...(Array.isArray(schema.allOf) ? schema.allOf : [])]) {
    try { supportsType(document, choice, expected, depth + 1); return } catch { /* ignore: another declared branch. */ }
  }
  throw invalid(`type ${expected}`)
}
/** Bound schema shape before handing it to the existing generated-schema compiler. */
export function parseExport(text: string): ObjectValue {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw invalid()
  const root: unknown = JSON.parse(text)
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }]
  let count = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++count > 250_000 || depth > 96) throw invalid()
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 })
    }
  }
  return object(root)
}
export function checkCodexSchema(document: ObjectValue): void {
  try {
    // Reuse the native protocol's required RPC/notification/approval schema checks.
    // This compiles schemas only; no transport or model session is constructed.
    const protocol = protocolFromBundle(document)
    const definitions = object(document.definitions)
    const v2 = definitions.v2 ? object(definitions.v2) : definitions
    for (const [name, contract] of Object.entries(CODEX_RESPONSE_FIELDS)) {
      const response = properties(document, v2[name] ?? definitions[name])
      for (const [field, type] of Object.entries(contract)) {
        try {
          fields(response, [field])
          supportsType(document, response[field], type === 'policy' ? 'string' : type)
        } catch { throw invalid(`${name}.${field} (${type})`) }
      }
    }
    fields(properties(document, v2.Thread ?? definitions.Thread), ['id', 'turns'])
    const start = properties(document, v2.ThreadStartParams ?? definitions.ThreadStartParams)
    fields(start, ['model', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'config', 'ephemeral', 'serviceTier'])
    supportsType(document, start.model, 'string')
    supportsType(document, start.ephemeral, 'boolean')
    supportsType(document, start.config, 'object')
    supportsEnum(document, start.sandbox, ['read-only', 'workspace-write', 'danger-full-access'])
    supportsEnum(document, start.approvalPolicy, ['on-request', 'never'])
    supportsEnum(document, start.approvalsReviewer, ['user', 'auto_review'])
    // These samples are validated in memory, NEVER dispatched to the CLI.
    protocol.request({ id: 1, method: 'thread/start', params: {
      model: 'compatibility-placeholder', cwd: process.cwd(), sandbox: 'read-only',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', ephemeral: true,
      serviceTier: null, config: { model_reasoning_effort: 'low', web_search: 'disabled' },
    } })
    protocol.request({ id: 2, method: 'config/read', params: { includeLayers: false } })
  } catch (error) {
    if (error instanceof CompatibilityCheckError) throw error
    throw invalid(errorMessage(error, 'protocol and settings'))
  }
}
