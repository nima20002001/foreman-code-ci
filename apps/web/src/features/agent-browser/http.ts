import { assertSession, installationHeaders, reloadChangedInstallation, sessionGeneration,
  sessionIsSwitching, sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'

/** Transport only. D supplies canonical C0 serialization/parsing; no wire shape lives here. */
export interface BrowserWireCodec<Arguments extends readonly unknown[], Result> {
  encode(...args: Arguments): { json?: unknown; bytes?: Uint8Array; query?: URLSearchParams; headers?: HeadersInit }
  decode(response: Response, args: Arguments): Promise<Result>
}

export type BrowserMethodCodec<Method> = Method extends (...args: infer Arguments) => Promise<infer Result>
  ? BrowserWireCodec<Arguments, Result> : never

export interface BrowserHttpOptions {
  fetch?: typeof fetch
  origin?: string
  error(response: Response): Promise<{ message: string; code?: string; outcome?: 'rejected' | 'unknown' }>
}

export function createBrowserHttp(options: BrowserHttpOptions) {
  return async function call<Arguments extends readonly unknown[], Result>(method: string, path: string,
    codec: BrowserWireCodec<Arguments, Result>, args: Arguments, signal?: AbortSignal): Promise<Result> {
    if (sessionIsSwitching()) throw new SessionChangedError()
    const generation = sessionGeneration()
    const requestSignal = signal ? AbortSignal.any([signal, sessionSignal()]) : sessionSignal()
    const encoded = codec.encode(...args)
    const url = new URL(path, options.origin ?? globalThis.location?.origin ?? 'http://localhost')
    if (encoded.query) url.search = encoded.query.toString()
    const headers = installationHeaders(encoded.headers)
    let body: BodyInit | undefined
    if (encoded.bytes) { body = new Uint8Array(encoded.bytes).buffer; headers.set('content-type', 'application/octet-stream') }
    else if (encoded.json !== undefined) { body = JSON.stringify(encoded.json); headers.set('content-type', 'application/json') }
    const response = await (options.fetch ?? globalThis.fetch)(url, { method, credentials: 'omit', cache: 'no-store', headers, body, signal: requestSignal })
    assertSession(generation); requestSignal.throwIfAborted()
    if (!response.ok) {
      const failure = await options.error(response)
      assertSession(generation); requestSignal.throwIfAborted()
      if (failure.code) reloadChangedInstallation(failure.code)
      throw Object.assign(new Error(failure.message), failure, { status: response.status })
    }
    const result = await codec.decode(response, args)
    assertSession(generation); requestSignal.throwIfAborted()
    return result
  }
}

export const browserSessionPath = (sessionId: string) => `/api/browser/sessions/${encodeURIComponent(sessionId)}`
export const browserProfilePath = (profileId: string) => `/api/browser/profiles/${encodeURIComponent(profileId)}`

