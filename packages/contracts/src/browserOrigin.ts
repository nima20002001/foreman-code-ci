import { resolveProductEnvironment } from './productEnvironment.mjs'
/** Resolve the configured frontend endpoint before starting either local service. */
export function resolveLocalBrowserOrigin(environment: Record<string, string | undefined>): {
  origin: string; host: string; port: number
} {
  environment = resolveProductEnvironment(environment)
  const selectedPort = environment.FOREMAN_CODE_WEB_PORT === undefined ? undefined : Number(environment.FOREMAN_CODE_WEB_PORT)
  if (selectedPort !== undefined && (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535)) {
    throw new Error('FOREMAN_CODE_WEB_PORT must be a valid TCP port.')
  }
  const legacy = environment.FOREMAN_CODE_DEV_BROWSER_ORIGIN === undefined ? undefined : new URL(environment.FOREMAN_CODE_DEV_BROWSER_ORIGIN)
  if (legacy && (legacy.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(legacy.hostname) || !legacy.port
    || legacy.username || legacy.password || legacy.pathname !== '/' || legacy.search || legacy.hash)) {
    throw new Error('FOREMAN_CODE_DEV_BROWSER_ORIGIN must be one exact HTTP loopback browser origin, including its port.')
  }
  const url = new URL(environment.FOREMAN_CODE_BROWSER_ORIGIN ?? legacy?.origin ?? `http://127.0.0.1:${selectedPort ?? 5173}`)
  if (legacy && legacy.origin !== url.origin) throw new Error('FOREMAN_CODE_DEV_BROWSER_ORIGIN conflicts with FOREMAN_CODE_BROWSER_ORIGIN.')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('FOREMAN_CODE_BROWSER_ORIGIN must be an exact HTTP loopback browser origin.')
  }
  const port = Number(url.port || 80)
  if (selectedPort !== undefined && selectedPort !== port) {
    throw new Error('FOREMAN_CODE_WEB_PORT conflicts with FOREMAN_CODE_BROWSER_ORIGIN.')
  }
  return { origin: url.origin, host: url.hostname.replace(/^\[|\]$/g, ''), port }
}
