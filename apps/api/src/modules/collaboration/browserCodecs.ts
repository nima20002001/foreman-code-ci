import { BrowserOperationRequestSchemas, BrowserOperationResponseSchemas } from '@foreman-code/contracts'
import type { BrowserCanonicalCodecs, BrowserOperationInputs, BrowserOperationName } from '../browser-runtime/operations.js'
import { DomainError } from '../errors.js'

function decode<Name extends BrowserOperationName>(name: Name, value: unknown): BrowserOperationInputs[Name] {
  if (name !== 'browser_action') return BrowserOperationRequestSchemas[name].parse(value) as BrowserOperationInputs[Name]
  const parsed = BrowserOperationRequestSchemas.browser_action.parse(value)
  if (parsed.intent === 'file' && parsed.phase === 'write') {
    const { contentBase64, ...input } = parsed
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.toString('base64') !== contentBase64 || bytes.byteLength > 262_144) {
      throw new DomainError('BROWSER_FILE_BYTES', 'Use a canonical base64 chunk of at most 256 KiB.', 400)
    }
    return { ...input, bytes } as unknown as BrowserOperationInputs[Name]
  }
  return parsed as BrowserOperationInputs[Name]
}

function encodedResult(value: unknown): unknown {
  if (value === undefined) return null
  if (value instanceof Uint8Array) return { contentBase64: Buffer.from(value).toString('base64') }
  if (!value || typeof value !== 'object') return value
  const result = value as Record<string, unknown>
  if (result.bytes instanceof Uint8Array) {
    const { bytes, ...metadata } = result
    return { ...metadata, contentBase64: Buffer.from(bytes).toString('base64') }
  }
  if (result.view && result.frame && typeof result.frame === 'object') {
    const { data, ...frame } = result.frame as Record<string, unknown>
    if (data instanceof Uint8Array) {
      const view = result.view as { sessionId: string; tabId: string; browserGeneration: number }
      return { ...result, frame: { ...frame, sessionId: view.sessionId, tabId: view.tabId,
        browserGeneration: view.browserGeneration, byteLength: data.byteLength,
        contentBase64: Buffer.from(data).toString('base64') } }
    }
  }
  return result
}

function httpInput(name: BrowserOperationName, request: Parameters<BrowserCanonicalCodecs[BrowserOperationName]['decodeHttp']>[0]) {
  const params = (request.params ?? {}) as Record<string, string>
  const query = (request.query ?? {}) as Record<string, unknown>
  let input: Record<string, unknown>
  try {
    input = typeof query.input === 'string' ? JSON.parse(query.input) as Record<string, unknown>
      : request.body instanceof Uint8Array ? {} : (request.body ?? query) as Record<string, unknown>
  } catch { throw new DomainError('BROWSER_INPUT_INVALID', 'The browser request could not be decoded.', 400) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('BROWSER_INPUT_INVALID', 'Use a browser request object.', 400)
  const path = { ...params }
  if (path.id) {
    path[name === 'browser_profile_sync_get' ? 'jobId' : 'sessionId'] = path.id
    delete path.id
  }
  for (const [key, value] of Object.entries(path)) {
    if (input[key] !== undefined && input[key] !== value) throw new DomainError('RESOURCE_ID_MISMATCH', 'The browser URL and request identify different resources.', 400)
  }
  // A view read/close is identified by its durable view; its session URL is checked by the service's location owner.
  if (name === 'browser_view_read' || name === 'browser_view_close') delete path.sessionId
  const combined = { ...input, ...path }
  if (request.body instanceof Uint8Array) combined.contentBase64 = Buffer.from(request.body).toString('base64')
  return combined
}

export function createBrowserCanonicalCodecs(): BrowserCanonicalCodecs {
  const entries = Object.keys(BrowserOperationRequestSchemas).map(key => {
    const name = key as BrowserOperationName
    return [name, {
      inputSchema: BrowserOperationRequestSchemas[name], outputSchema: BrowserOperationResponseSchemas[name],
      decodeMcp: (value: unknown) => decode(name, value),
      decodeHttp: (request: Parameters<BrowserCanonicalCodecs[typeof name]['decodeHttp']>[0]) => decode(name, httpInput(name, request)),
      encode: (value: unknown) => BrowserOperationResponseSchemas[name].parse(encodedResult(value)),
    }]
  })
  return Object.fromEntries(entries) as BrowserCanonicalCodecs
}
