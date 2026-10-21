import { describe, expect, it } from 'vitest'
import { COMPUTER_MAINTENANCE_NAMESPACE, COMPUTER_MAINTENANCE_VERSION,
  ComputerMaintenanceStartInputSchema, ComputerMaintenanceOperatorListInputSchema,
  ComputerMaintenanceListInputSchema, ComputerMaintenanceReadInputSchema,
  MaintenanceRequestSchema, MaintenanceTaskStartSchema, MaintenanceStatusSchema,
  MaintenanceTaskSchema, SyncedMarketplaceSchema,
  SyncedMcpServerSchema, WORKER_UPDATE_NAMESPACE, WORKER_UPDATE_VERSION, WORKER_UPDATE_MAX_JSON_BYTES,
  WORKER_UPDATE_MAX_BINARY_BYTES, WorkerArtifactRequestSchema, WorkerArtifactReplySchema,
  WorkerUpdateStatusSchema } from './computerMaintenance.js'
import { ClaudePluginMarketplaceAddInputSchema } from './management/claudePlugins.js'
import { negotiateDeviceExtensions } from './deviceApplication.js'
import { HarnessMcpConnectionSchema } from './management/harnessSettings.js'

describe('fleet MCP credential restrictions', () => {
  it.each([
    'https://service.example/mcp?api_key=fixture-secret',
    'https://owner:fixture-secret@service.example/mcp',
    'https://service.example/mcp#fixture-secret',
  ])('rejects credential-bearing endpoints at native and fleet boundaries: %s', url => {
    expect(HarnessMcpConnectionSchema.safeParse({ transport: 'remote', url }).success).toBe(false)
    expect(SyncedMcpServerSchema.safeParse({ transport: 'http', name: 'docs', url,
      bearerTokenEnvVar: null }).success).toBe(false)
  })

  it.each([
    ['--api-key=fixture-secret'], ['--api-key', 'fixture-secret'],
    ['--access-token', 'fixture-secret'], ['Authorization: Bearer fixture-secret'],
    ['--password:fixture-secret'],
  ].map(args => ({ args })))('rejects inline arguments at native and fleet boundaries: %j', ({ args }) => {
    expect(HarnessMcpConnectionSchema.safeParse({ transport: 'stdio', executable: '/usr/bin/server',
      arguments: args }).success).toBe(false)
    expect(SyncedMcpServerSchema.safeParse({ transport: 'stdio', name: 'docs', command: '/usr/bin/server',
      args, envVars: [] }).success).toBe(false)
  })

  it('accepts per-computer authentication references and ordinary server arguments', () => {
    expect(SyncedMcpServerSchema.safeParse({ transport: 'http', name: 'docs',
      url: 'https://service.example/mcp', bearerTokenEnvVar: 'SERVICE_TOKEN' }).success).toBe(true)
    expect(SyncedMcpServerSchema.safeParse({ transport: 'stdio', name: 'docs', command: 'npx',
      args: ['server-token', '--token-env-var', 'SERVICE_TOKEN'], envVars: [] }).success).toBe(true)
  })

  it('rejects stdio environment references that the fleet add commands cannot restore', () => {
    expect(SyncedMcpServerSchema.safeParse({ transport: 'stdio', name: 'docs', command: 'server',
      args: [], envVars: ['REMOTE_TOKEN'] }).success).toBe(false)
  })
})

describe('fleet source availability', () => {
  it.each([
    'https://owner:fixture-password@plugins.example/repo.git',
    'https://fixture-token@plugins.example/repo.git',
    'https://plugins.example/repo.git?access_token=fixture-token',
    'https://plugins.example/repo.git#fixture-token',
    'ssh://git:fixture-password@plugins.example/repo.git',
  ])('rejects credential-bearing marketplace sources at both native and fleet inputs: %s', source => {
    expect(SyncedMarketplaceSchema.safeParse({ name: 'plugins', source }).success).toBe(false)
    expect(ClaudePluginMarketplaceAddInputSchema.safeParse({ source,
      commandId: '44444444-4444-4444-8444-444444444444', expectedRevision: 'a'.repeat(64) }).success).toBe(false)
  })

  it.each(['owner/repo', 'https://plugins.example/repo.git', 'git@plugins.example:owner/repo.git',
    'ssh://git@plugins.example/owner/repo.git'])('accepts credential-free marketplace sources: %s', source => {
    expect(SyncedMarketplaceSchema.parse({ name: 'plugins', source })).toEqual({ name: 'plugins', source })
  })

  it('rejects duplicate harnesses at both management and receiver inputs', () => {
    const task = { kind: 'update-harnesses', harnesses: ['codex', 'codex'] }
    expect(MaintenanceTaskStartSchema.safeParse(task).success).toBe(false)
    expect(ComputerMaintenanceStartInputSchema.safeParse({ task,
      commandId: '44444444-4444-4444-8444-444444444444' }).success).toBe(false)
  })

  it('accepts an available empty catalog while omitting an unavailable harness', () => {
    expect(MaintenanceTaskStartSchema.parse({ kind: 'sync-mcp', servers: { codex: [] } }))
      .toEqual({ kind: 'sync-mcp', servers: { codex: [] } })
    expect(MaintenanceTaskStartSchema.parse({ kind: 'sync-plugins', claudePlugins: [], claudeMarketplaces: [] }))
      .toEqual({ kind: 'sync-plugins', claudePlugins: [], claudeMarketplaces: [] })
  })

  it('carries skipped names separately from an empty available catalog', () => {
    const task = { kind: 'sync-mcp', servers: { codex: [] }, skippedServers: { codex: ['restricted'] } }
    expect(MaintenanceTaskStartSchema.parse(task)).toEqual(task)
  })

  it('rejects missing or incomplete source catalogs', () => {
    for (const task of [
      { kind: 'sync-mcp', servers: {} },
      { kind: 'sync-plugins' },
      { kind: 'sync-plugins', plugins: [], claudePlugins: [], claudeMarketplaces: [] },
      { kind: 'sync-plugins', plugins: [], marketplaces: [], claudeMarketplaces: [] },
    ]) expect(MaintenanceTaskStartSchema.safeParse(task).success).toBe(false)
  })
})

describe('maintenance protocol negotiation', () => {
  const descriptor = { namespace: COMPUTER_MAINTENANCE_NAMESPACE, version: COMPUTER_MAINTENANCE_VERSION,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const legacy = { ...descriptor, namespace: 'computer-maintenance-v1', version: 1 }

  it('refuses maintenance for either rolling-upgrade order', () => {
    expect(negotiateDeviceExtensions([{ ...descriptor, role: 'client' }], [{ ...legacy, role: 'server' }]))
      .toEqual([])
    expect(negotiateDeviceExtensions([{ ...legacy, role: 'client' }], [{ ...descriptor, role: 'server' }]))
      .toEqual([])
    expect(negotiateDeviceExtensions([{ ...descriptor, role: 'client' }], [{ ...descriptor, role: 'server' }]))
      .toMatchObject([{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, version: COMPUTER_MAINTENANCE_VERSION,
        mainCanRequest: true }])
  })

  it('requires a receiver command identity even for partial catalogs with warnings', () => {
    const request = { operation: 'start', task: { kind: 'sync-mcp', servers: { codex: [] }, warnings: ['Claude unavailable'] } }
    expect(MaintenanceRequestSchema.safeParse(request).success).toBe(false)
    expect(MaintenanceRequestSchema.parse({ ...request, commandId: '44444444-4444-4444-8444-444444444444' }))
      .toEqual({ ...request, commandId: '44444444-4444-4444-8444-444444444444' })
  })
})

describe('Worker updates', () => {
  it('accepts the same update task through the public and device APIs', () => {
    const task = { kind: 'update-worker' }
    const commandId = '44444444-4444-4444-8444-444444444444'
    expect(MaintenanceTaskStartSchema.parse(task)).toEqual(task)
    expect(ComputerMaintenanceStartInputSchema.parse({ commandId, task })).toEqual({ commandId, task })
    expect(MaintenanceRequestSchema.parse({ operation: 'start', commandId, task }))
      .toEqual({ operation: 'start', commandId, task })
  })

  it('keeps Worker status optional and reports failed updates without changing task history', () => {
    const status = { harnesses: [], system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null },
      tasks: [], observedAt: '2026-10-10T00:00:00.000Z' }
    expect(MaintenanceStatusSchema.parse(status)).toEqual(status)
    const worker = { currentVersion: '0.0.56', targetVersion: '0.0.57', state: 'rolled-back', lastError: 'Start failed' }
    expect(MaintenanceStatusSchema.parse({ ...status, worker })).toEqual({ ...status, worker })
    expect(WorkerUpdateStatusSchema.safeParse({ ...worker, state: 'complete' }).success).toBe(false)
  })

  it('retains the restart target on an in-progress Worker update task', () => {
    const task = { id: '44444444-4444-4444-8444-444444444444', kind: 'update-worker', state: 'running',
      startedAt: '2026-10-10T00:00:00.000Z', finishedAt: null, summary: 'Restarting Worker', outputTail: '' }
    expect(MaintenanceTaskSchema.parse(task)).toEqual(task)
    expect(MaintenanceTaskSchema.parse({ ...task, workerTargetVersion: '0.0.57' }))
      .toEqual({ ...task, workerTargetVersion: '0.0.57' })
  })

  it('negotiates artifact requests from Worker to Main only', () => {
    const descriptor = { namespace: WORKER_UPDATE_NAMESPACE, version: WORKER_UPDATE_VERSION,
      maxJsonBytes: WORKER_UPDATE_MAX_JSON_BYTES, maxBinaryBytes: WORKER_UPDATE_MAX_BINARY_BYTES }
    expect(negotiateDeviceExtensions([{ ...descriptor, role: 'server' }], [{ ...descriptor, role: 'client' }]))
      .toMatchObject([{ workerCanRequest: true, mainCanRequest: false, maxBinaryBytes: 0 }])
  })

  it('rejects all removed Worker bundle chunk requests and replies', () => {
    const request = { operation: 'chunk', manifestSha256: 'a'.repeat(64), path: 'src/cli.mjs', offset: 0 }
    expect(WorkerArtifactRequestSchema.safeParse(request).success).toBe(false)
    expect(WorkerArtifactRequestSchema.safeParse({ ...request, path: 'manifest.json' }).success).toBe(false)
    for (const path of ['/etc/passwd', '../identity.json', 'src//cli.mjs', 'src/./cli.mjs']) {
      expect(WorkerArtifactRequestSchema.safeParse({ ...request, path }).success).toBe(false)
    }
    expect(WorkerArtifactRequestSchema.safeParse({ ...request, offset: Number.MAX_SAFE_INTEGER }).success).toBe(false)
    expect(WorkerArtifactReplySchema.safeParse({ ...request, byteSize: 262_145 }).success).toBe(false)
  })
})


describe('Operator maintenance detail selection', () => {
  const target = {
    hostRef: { kind: 'main', mainId: '11111111-1111-4111-8111-111111111111' },
    applicationInstallationId: '22222222-2222-4222-8222-222222222222',
    keyRevision: null,
    authorizationRevision: null,
  }

  it.each(Array.from({ length: 50 }, (_, index) => index + 1))(
    'accepts taskLimit %i at HTTP and MCP boundaries', taskLimit => {
      expect(ComputerMaintenanceListInputSchema.parse({ taskLimit })).toEqual({ taskLimit })
      expect(ComputerMaintenanceOperatorListInputSchema.parse({ taskLimit })).toEqual({ taskLimit })
      expect(ComputerMaintenanceListInputSchema.parse({ target, taskLimit })).toEqual({ target, taskLimit })
      expect(ComputerMaintenanceOperatorListInputSchema.parse({ target, taskLimit })).toEqual({ target, taskLimit })
      expect(ComputerMaintenanceReadInputSchema.parse({ target, taskLimit })).toEqual({ target, taskLimit })
    })

  it.each([0, 51, 1.5, '5', null])('rejects invalid taskLimit %j at HTTP and MCP boundaries', taskLimit => {
    expect(ComputerMaintenanceListInputSchema.safeParse({ taskLimit }).success).toBe(false)
    expect(ComputerMaintenanceOperatorListInputSchema.safeParse({ taskLimit }).success).toBe(false)
    expect(ComputerMaintenanceReadInputSchema.safeParse({ target, taskLimit }).success).toBe(false)
  })

  it('allows full task selection and rejects task selection without full detail', () => {
    const taskId = '77777777-7777-4777-8777-777777777777'
    expect(ComputerMaintenanceOperatorListInputSchema.parse({})).toEqual({})
    expect(ComputerMaintenanceOperatorListInputSchema.parse({ detail: 'full', taskId }))
      .toEqual({ detail: 'full', taskId })
    expect(ComputerMaintenanceOperatorListInputSchema.safeParse({ taskId }).success).toBe(false)
    expect(ComputerMaintenanceOperatorListInputSchema.safeParse({ detail: 'compact', taskId }).success).toBe(false)
    expect(ComputerMaintenanceOperatorListInputSchema.safeParse({ detail: 'full', taskId: 'invalid' }).success).toBe(false)
  })
})
