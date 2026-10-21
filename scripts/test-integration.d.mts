import type { VerificationCapability, VerificationEnvironment }
  from '../packages/contracts/src/verificationEnvironment.mjs'

interface TestCounts {
  total: number
  passed: number
  failed: number
  skipped: number
}

interface IntegrationFileResult {
  file: string
  code: number | null
  complete: boolean
  requiredCapabilities?: VerificationCapability[]
  reason?: string
  report?: { totals: TestCounts }
}

export function integrationReport(
  selected: string[],
  firstPass: IntegrationFileResult[],
  retests: IntegrationFileResult[],
  options: {
    startedAt: string
    finishedAt: string
    interrupted?: string
    diagnostic: boolean
    processStopped: boolean
    environment?: VerificationEnvironment
  },
): {
  schemaVersion: 1
  suite: 'integration'
  startedAt: string
  finishedAt: string
  environment: VerificationEnvironment | undefined
  outcome: 'passed' | 'failed' | 'incomplete' | 'cancelled'
  completeness: 'complete' | 'partial'
  expectedPortions: number
  completedPortions: number
  firstPassFailed: number
  disallowedSkipped: number
  totals: TestCounts
  files: Array<Omit<IntegrationFileResult, 'report'> & { totals?: TestCounts }>
  retests: Array<Omit<IntegrationFileResult, 'report'> & { totals: TestCounts }>
}

export function integrationGate(environment: Record<string, string | undefined>): boolean

export function scheduleIntegrationQueue(files: string[], slots: { index: number }[], options: {
  gate?: boolean
  maxConcurrency?: number
  pollIntervalMs?: number
  samplePressure?: () => Record<string, number>
  runFile: (...args: never[]) => Promise<{ code: number | null; complete: boolean }>
  prepareRetest?: (...args: never[]) => Promise<void>
  [option: string]: unknown
}): Promise<{ results: { file: string; status: string }[] }>

interface IntegrationResources {
  cpuCount: number
  availableMemoryBytes: number
  maxConnections: number
  reservedConnections: number
  activeConnections: number
}
export function readIntegrationResources(
  admin: { query(text: string): Promise<{ rows: Record<string, unknown>[] }> },
  host?: Pick<IntegrationResources, 'cpuCount' | 'availableMemoryBytes'>,
): Promise<IntegrationResources>
export function integrationShardPlan(
  environment: NodeJS.ProcessEnv,
  resources?: Partial<IntegrationResources>,
  fileCount?: number,
): { shards: number; limit: number; reason: string }
