import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'
import { isAbsolute } from 'node:path'
import { resolveLocalBrowserOrigin } from '@foreman-code/contracts/browser-origin'
import { z } from 'zod'
import { DEFAULT_AGENT_ACTIVE_TIMEOUT_MS } from '@foreman-code/contracts/wave25'
import { DEFAULT_STUCK_EXECUTION_IDLE_MS } from '@foreman-code/contracts'
import type { RemoteExecutionEnvironmentVariable, WorkerExecutionSettings } from '@foreman-code/contracts/management'
import { RemoteExecutionEnvironmentVariableSchema } from '@foreman-code/contracts/management'
import { defaultFileStorageRoot } from './modules/files/storage.js'
import { harnessBinaries } from './modules/harnesses/binaries.js'

const databaseSchemaName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z_][a-z0-9_]*$/, 'must be a lowercase PostgreSQL identifier')

const EnvironmentSchema = z.object({
  HOST: z.enum(['127.0.0.1', '::1', 'localhost'], {
    error: 'The local app requires a loopback HOST: 127.0.0.1, ::1 or localhost.',
  }).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().max(2147483647).default(1000),
  READINESS_TIMEOUT_MS: z.coerce.number().int().positive().max(2147483647).default(2000),
  LANGGRAPH_CHECKPOINT_SCHEMA: databaseSchemaName.default('langgraph'),
  FILE_STORAGE_ROOT: z.string().trim().min(1).refine(isAbsolute, 'File storage requires an absolute directory').optional(),
  WORKSPACE_STORAGE_ROOT: z.string().trim().min(1).refine(isAbsolute, 'Workspace storage requires an absolute directory').optional(),
  HARNESS_WORKSPACE_ROOT: z.string().trim().min(1).default('/tmp/graphql-harness-runs'),
  HARNESS_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_AGENT_ACTIVE_TIMEOUT_MS),
  FOREMAN_CODE_STUCK_EXECUTION_IDLE_MS: z.coerce.number().int().positive()
    .default(DEFAULT_STUCK_EXECUTION_IDLE_MS),
  CODEX_BINARY: z.string().trim().min(1).default('codex'),
  FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: z.enum(['0', '1']).default('0'),
  FOREMAN_CODE_LOCAL_PRODUCTION: z.enum(['0', '1']).default('0'),
  FOREMAN_CODE_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: z.enum(['0', '1']).optional(),
  FOREMAN_CODE_ENABLE_EXPERIMENTAL_CLAUDE_SDK: z.enum(['0', '1']).optional(),
})

export interface ApiConfig {
  remoteExecutionEnvironment?: Partial<Record<RemoteExecutionEnvironmentVariable, string>>
  workerExecution?: WorkerExecutionSettings
  /** Trusted composition override for an isolated storage root; never a request field. */
  workspaceStorageRoot?: string
  /** App-managed durable upload storage; separate from workspace and harness directories. */
  fileStorageRoot?: string
  browserOrigin?: string
  host: string
  port: number
  readinessTimeoutMs: number
  /** FOREMAN_CODE_STUCK_EXECUTION_IDLE_MS; reports idle Agents without canceling them. */
  stuckExecutionIdleMs?: number
  database: {
    connectionString: string
    maxConnections: number
    connectionTimeoutMs: number
    queryTimeoutMs: number
  }
  checkpoints: {
    schema: string
  }
  harnesses: {
    workspaceRoot: string
    timeoutMs: number
    codexBinary: string
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  environment = resolveProductEnvironment(environment)
  const parsed = EnvironmentSchema.parse(environment)
  if (parsed.FOREMAN_CODE_LOCAL_PRODUCTION === '1'
    && (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.HOST)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(parsed.DATABASE_URL).hostname))) {
    throw new Error('Local production requires a loopback API and database.')
  }
  const browserOrigin = resolveLocalBrowserOrigin(environment).origin
  return {
    remoteExecutionEnvironment: Object.fromEntries(RemoteExecutionEnvironmentVariableSchema.options
      .filter(key => environment[key] !== undefined).map(key => [key, environment[key]])),
    workerExecution: {
      enabled: parsed.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED === '1',
      managedBy: environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED === undefined ? 'settings' : 'startup',
    },
    browserOrigin,
    fileStorageRoot: parsed.FILE_STORAGE_ROOT ?? defaultFileStorageRoot(),
    ...(parsed.WORKSPACE_STORAGE_ROOT ? { workspaceStorageRoot: parsed.WORKSPACE_STORAGE_ROOT } : {}),
    host: parsed.HOST,
    port: parsed.PORT,
    readinessTimeoutMs: parsed.READINESS_TIMEOUT_MS,
    stuckExecutionIdleMs: parsed.FOREMAN_CODE_STUCK_EXECUTION_IDLE_MS,
    database: {
      connectionString: parsed.DATABASE_URL,
      maxConnections: parsed.DATABASE_POOL_MAX,
      connectionTimeoutMs: parsed.DATABASE_CONNECTION_TIMEOUT_MS,
      queryTimeoutMs: parsed.DATABASE_QUERY_TIMEOUT_MS,
    },
    checkpoints: { schema: parsed.LANGGRAPH_CHECKPOINT_SCHEMA },
    harnesses: {
      workspaceRoot: parsed.HARNESS_WORKSPACE_ROOT,
      timeoutMs: parsed.HARNESS_TIMEOUT_MS,
      ...harnessBinaries(environment),
    },
  }
}
