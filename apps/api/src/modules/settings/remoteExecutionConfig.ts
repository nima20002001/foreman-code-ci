import {
  RemoteExecutionSettingsSchema, RemoteExecutionEnvironmentVariableSchema,
  type RemoteExecutionSettings, type RemoteExecutionEnvironmentVariable, type WorkerExecutionSettings,
} from '@foreman-code/contracts/management'
import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'
import { readDeviceListenerConfig, type DeviceListenerConfig } from '../devices/productionConfig.js'

const listenerVariables = {
  host: 'DEVICE_LISTENER_HOST',
  port: 'DEVICE_LISTENER_PORT',
  certificateFile: 'DEVICE_LISTENER_TLS_CERT_FILE',
  privateKeyFile: 'DEVICE_LISTENER_TLS_KEY_FILE',
  advertisedEndpoint: 'DEVICE_LISTENER_ADVERTISED_ENDPOINT',
  trustCertificateFile: 'DEVICE_LISTENER_TLS_TRUST_CERT_FILE',
} as const

export function remoteExecutionStartupEnvironment(options: {
  listener: DeviceListenerConfig | undefined
  workerExecution: WorkerExecutionSettings | undefined
  environment: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  if (options.workerExecution?.managedBy === 'startup') {
    environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED = options.workerExecution.enabled ? '1' : '0'
  }
  if (options.listener) {
    environment.FOREMAN_CODE_DEVICE_LISTENER_ENABLED = '1'
    for (const key of Object.keys(listenerVariables) as Array<keyof typeof listenerVariables>) {
      const value = options.listener[key]
      if (value !== undefined) environment[listenerVariables[key]] = String(value)
    }
  }
  return { ...environment, ...options.environment }
}

function enabledOverride(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value !== '0' && value !== '1') throw new Error('Remote execution enablement must be 0 or 1.')
  return value === '1'
}

export function resolveRemoteExecutionSettings(saved: RemoteExecutionSettings, rawEnvironment: NodeJS.ProcessEnv) {
  const environment = resolveProductEnvironment(rawEnvironment)
  const listener = { ...saved.listener }
  listener.enabled = enabledOverride(environment.FOREMAN_CODE_DEVICE_LISTENER_ENABLED, listener.enabled)
  for (const key of ['host', 'certificateFile', 'privateKeyFile', 'advertisedEndpoint', 'trustCertificateFile'] as const) {
    const override = environment[listenerVariables[key]]
    if (override !== undefined) listener[key] = override.trim() || null
  }
  if (environment.DEVICE_LISTENER_PORT !== undefined) listener.port = Number(environment.DEVICE_LISTENER_PORT)
  const effective = RemoteExecutionSettingsSchema.parse({
    enabled: enabledOverride(environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED, saved.enabled), listener,
  })
  const environmentOverrides: RemoteExecutionEnvironmentVariable[] = RemoteExecutionEnvironmentVariableSchema.options
    .filter(key => environment[key] !== undefined)
  return { effective, environmentOverrides }
}

export function remoteExecutionListenerConfig(settings: RemoteExecutionSettings, apiPort: number) {
  const environment: NodeJS.ProcessEnv = {
    FOREMAN_CODE_DEVICE_LISTENER_ENABLED: settings.listener.enabled ? '1' : '0',
  }
  for (const key of Object.keys(listenerVariables) as Array<keyof typeof listenerVariables>) {
    const value = settings.listener[key]
    if (value !== null) environment[listenerVariables[key]] = String(value)
  }
  return readDeviceListenerConfig(environment, apiPort)
}
