import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'
import { isAbsolute } from 'node:path'

export interface DeviceListenerConfig {
  host: string
  port: number
  certificateFile: string
  privateKeyFile: string
  /** Explicit public installer endpoint; bind addresses are never advertised implicitly. */
  advertisedEndpoint?: string
  trustCertificateFile?: string
}

/** Source configuration alone grants no pairing, task or provider credentials. */
export function readDeviceListenerConfig(environment: NodeJS.ProcessEnv, apiPort: number): DeviceListenerConfig | undefined {
  environment = resolveProductEnvironment(environment)
  const enabled = environment.FOREMAN_CODE_DEVICE_LISTENER_ENABLED
  if (enabled !== undefined && enabled !== '0' && enabled !== '1') throw new Error('Device listener enablement must be 0 or 1.')
  if (enabled !== '1') return undefined
  const host = environment.DEVICE_LISTENER_HOST?.trim()
  const port = Number(environment.DEVICE_LISTENER_PORT)
  const certificateFile = environment.DEVICE_LISTENER_TLS_CERT_FILE?.trim()
  const privateKeyFile = environment.DEVICE_LISTENER_TLS_KEY_FILE?.trim()
  if (!host || /[\s/\\]/.test(host)) throw new Error('The enabled device listener requires an explicit bind host.')
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === apiPort) throw new Error('The enabled device listener requires its own explicit valid port.')
  if (!certificateFile || !privateKeyFile || !isAbsolute(certificateFile) || !isAbsolute(privateKeyFile)) {
    throw new Error('The enabled device listener requires absolute TLS certificate and private key files.')
  }
  const trustCertificateFile = environment.DEVICE_LISTENER_TLS_TRUST_CERT_FILE?.trim()
  if (trustCertificateFile && !isAbsolute(trustCertificateFile)) throw new Error('The device trust anchor requires an explicit absolute approved public CA file.')
  const advertisedEndpoint = environment.DEVICE_LISTENER_ADVERTISED_ENDPOINT?.trim()
  if (advertisedEndpoint) {
    const endpoint = new URL(advertisedEndpoint)
    if (endpoint.protocol !== 'wss:' || endpoint.pathname !== '/device/connect' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || ['0.0.0.0', '[::]', '::'].includes(endpoint.hostname)) throw new Error('The advertised device endpoint must be an explicit reachable WSS device URL.')
  }
  return { host, port, certificateFile, privateKeyFile, ...(advertisedEndpoint ? { advertisedEndpoint } : {}), ...(trustCertificateFile ? { trustCertificateFile } : {}) }
}
