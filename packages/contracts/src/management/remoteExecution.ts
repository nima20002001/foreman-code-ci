import { optionalCommandId } from './commands.js'
import { z } from 'zod'
import { WORKER_EXECUTION_STARTUP_VARIABLE } from './workerExecution.js'

const absolutePath = z.string().trim().min(1).max(4096).refine(
  value => value.startsWith('/') && !value.includes('\0'), 'Use an absolute file path.',
)
const endpoint = z.string().trim().max(2048).refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'wss:' && url.pathname === '/device/connect'
      && !url.username && !url.password && !url.search && !url.hash
      && !['0.0.0.0', '[::]', '::'].includes(url.hostname)
  } catch {
    return false
  }
}, 'Use a reachable WSS URL ending in /device/connect.')

const DeviceListenerSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253).regex(/^[^\s/\\]+$/).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  certificateFile: absolutePath.nullable(),
  privateKeyFile: absolutePath.nullable(),
  advertisedEndpoint: endpoint.nullable(),
  trustCertificateFile: absolutePath.nullable(),
}).strict().superRefine((value, context) => {
  if (!value.enabled) return
  for (const key of ['host', 'port', 'certificateFile', 'privateKeyFile'] as const) {
    if (value[key] === null) context.addIssue({ code: 'custom', path: [key], message: 'Required when enabled.' })
  }
})

export const RemoteExecutionSettingsSchema = z.object({
  enabled: z.boolean(),
  listener: DeviceListenerSettingsSchema,
}).strict()

export const DEFAULT_REMOTE_EXECUTION_SETTINGS = RemoteExecutionSettingsSchema.parse({
  enabled: false,
  listener: {
    enabled: false, host: null, port: null, certificateFile: null, privateKeyFile: null,
    advertisedEndpoint: null, trustCertificateFile: null,
  },
})

const RemoteExecutionSettingSnapshotSchema = z.object({
  value: RemoteExecutionSettingsSchema,
  revision: z.number().int().nonnegative(),
  versionId: z.string().min(1).nullable(),
}).strict()

export const RemoteExecutionEnvironmentVariableSchema = z.enum([
  WORKER_EXECUTION_STARTUP_VARIABLE, 'FOREMAN_CODE_DEVICE_LISTENER_ENABLED',
  'DEVICE_LISTENER_HOST', 'DEVICE_LISTENER_PORT', 'DEVICE_LISTENER_TLS_CERT_FILE',
  'DEVICE_LISTENER_TLS_KEY_FILE', 'DEVICE_LISTENER_ADVERTISED_ENDPOINT', 'DEVICE_LISTENER_TLS_TRUST_CERT_FILE',
])

const RemoteExecutionRuntimeStatusSchema = z.object({
  listenerEnabled: z.boolean(),
  listenerEndpoint: z.string().nullable(),
  restartRequired: z.boolean(),
  reason: z.enum(['computers-connected', 'listener-start-failed']).nullable(),
}).strict()

export const ManagedRemoteExecutionSettingsSchema = RemoteExecutionSettingSnapshotSchema.extend({
  effective: RemoteExecutionSettingsSchema,
  environmentOverrides: z.array(RemoteExecutionEnvironmentVariableSchema),
  runtime: RemoteExecutionRuntimeStatusSchema,
}).strict()

export const RemoteExecutionSettingsUpdateInputSchema = z.object({
  value: RemoteExecutionSettingsSchema,
  expectedRevision: z.number().int().nonnegative().optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  commandId: optionalCommandId(z.string().trim().min(8).max(200)),
}).strict()

export const RemoteExecutionSettingsUpdateResultSchema = z.object({
  value: RemoteExecutionSettingSnapshotSchema,
  replayed: z.boolean(),
  runtime: RemoteExecutionRuntimeStatusSchema,
}).strict()

export type RemoteExecutionSettings = z.infer<typeof RemoteExecutionSettingsSchema>
export type RemoteExecutionRuntimeStatus = z.infer<typeof RemoteExecutionRuntimeStatusSchema>
export type RemoteExecutionSettingsUpdateInput = z.infer<typeof RemoteExecutionSettingsUpdateInputSchema>
export type RemoteExecutionEnvironmentVariable = z.infer<typeof RemoteExecutionEnvironmentVariableSchema>
