import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, MaintenanceRequestSchema,
  type MaintenanceTaskStart,
} from '@foreman-code/contracts/computer-maintenance'
import { ComputerMaintenance, type MaintenancePorts } from '../../src/modules/computers/maintenance.js'
import { FleetMaintenanceService, type FleetSources } from '../../src/modules/computers/fleet.js'
import type { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'

export const server = (name: string) => ({
  name, transport: 'http' as const, url: `https://${name}.example/mcp`, bearerTokenEnvVar: null,
})
export const mcpRequest = (names: string[]): MaintenanceTaskStart => ({
  kind: 'sync-mcp', servers: { codex: names.map(server), claude: names.map(server) },
})
export const pluginRequest = (names: string[]): MaintenanceTaskStart => ({
  kind: 'sync-plugins', plugins: names, marketplaces: [],
  claudePlugins: names.map(pluginId => ({ pluginId, enabled: true })), claudeMarketplaces: [],
})

export function fakeComputer() {
  const codexMcp = new Set<string>()
  const codexDefinitions = new Map<string, unknown>()
  const claudeMcp = new Map<string, unknown>()
  const codexPlugins = new Set<string>()
  const claudePlugins = new Map<string, boolean>()
  const files = new Map<string, string>()
  const calls: { binary: string; args: string[] }[] = []
  let claudeVersion = '1.2.3'
  let failure: (binary: string, args: string[]) => boolean = () => false
  const result = (value: unknown = {}, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: '' })
  const ports: MaintenancePorts = {
    environment: { HOME: '/fake/home' },
    find: async name => ['codex', 'claude', 'npm', 'server', 'updated-server', 'npx'].includes(name) ? `/fake/${name}` : null,
    run: async (binary, suppliedArgs) => {
      calls.push({ binary, args: suppliedArgs })
      let commandIndex = 0
      while (suppliedArgs[commandIndex] === '-c') commandIndex += 2
      const args = suppliedArgs.slice(commandIndex)
      if (binary === 'sudo' && args.join(' ') === '-n true') {
        return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
      }
      if (failure(binary, args)) return result({}, 1)
      if (args[0] === '--version') {
        return { code: 0, stdout: binary.endsWith('claude') ? claudeVersion : '1.2.3', stderr: '' }
      }
      if (binary.endsWith('npm') && args[0] === 'view') {
        return { code: 0, stdout: args[1] === '@anthropic-ai/claude-code' ? '1.2.4' : '1.2.3', stderr: '' }
      }
      if (binary.endsWith('claude') && args[0] === 'update') {
        claudeVersion = '1.2.4'
        return { code: 0, stdout: 'Updated Claude Code', stderr: '' }
      }
      if (args[0] === 'mcp') {
        if (args[1] === 'list') return result([...codexMcp].map(name => ({ name, transport: codexDefinitions.get(name) })))
        if (args[1] === 'add') {
          codexMcp.add(args[2]!)
          const separator = args.indexOf('--')
          codexDefinitions.set(args[2]!, separator >= 0
            ? { type: 'stdio', command: args[separator + 1], args: args.slice(separator + 2) }
            : { type: 'streamable_http', url: args[args.indexOf('--url') + 1],
              bearer_token_env_var: args.includes('--bearer-token-env-var')
                ? args[args.indexOf('--bearer-token-env-var') + 1] : null })
        }
        if (args[1] === 'remove' && binary.endsWith('codex')) codexMcp.delete(args[2]!)
        if (args[1] === 'add-json') claudeMcp.set(args[4]!, JSON.parse(args[5]!) as unknown)
        if (args[1] === 'remove' && binary.endsWith('claude')) claudeMcp.delete(args[4]!)
        return result()
      }
      if (args[0] === 'plugin' && binary.endsWith('codex')) {
        if (args[1] === 'list') {
          return result({ installed: [...codexPlugins].map(pluginId => ({ pluginId, installed: true })) })
        }
        if (args[1] === 'marketplace') {
          return result({ marketplaces: [{ name: 'official', marketplaceSource: {
            sourceType: 'git', source: 'owner/official',
          } }] })
        }
        if (args[1] === 'add') codexPlugins.add(args[2]!)
        if (args[1] === 'remove') codexPlugins.delete(args[2]!)
        return result()
      }
      if (args[0] === 'plugin' && binary.endsWith('claude')) {
        if (args[1] === 'list') return result({
          installed: [...claudePlugins].map(([id, enabled]) => ({ id, scope: 'user', enabled })), available: [],
        })
        if (args[1] === 'marketplace' && args[2] === 'list') return result([])
        if (args[1] === 'install') claudePlugins.set(args[2]!, true)
        if (args[1] === 'uninstall') claudePlugins.delete(args[2]!)
        if (args[1] === 'enable') claudePlugins.set(args[2]!, true)
        if (args[1] === 'disable') claudePlugins.set(args[2]!, false)
        return result({ outcome: 'ok' })
      }
      return result({}, 1)
    },
    exists: async () => false,
    readText: async path => path.endsWith('/.claude.json')
      ? JSON.stringify({ mcpServers: Object.fromEntries(claudeMcp) }) : files.get(path) ?? null,
    writePrivateText: async (path, text) => { files.set(path, text) },
    disk: async () => null,
    later: () => {},
    now: () => new Date(),
  }
  const maintenance = new ComputerMaintenance(ports)
  return {
    maintenance, ports, codexMcp, codexDefinitions, claudeMcp, codexPlugins, claudePlugins, calls, files,
    fail: (predicate: typeof failure) => { failure = predicate },
  }
}

export async function settle(computer: ReturnType<typeof fakeComputer>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await computer.maintenance.status(AbortSignal.timeout(1000))
    if (status.tasks.every(task => task.state !== 'running')) return status
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Fake maintenance did not settle')
}

export function fakeFleet(computer: ReturnType<typeof fakeComputer>, now: () => number = Date.now) {
  const mainId = randomUUID()
  const registration = {
    mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64),
  }
  const registrations = [registration]
  const pool = {
    connect: async () => ({
      query: async () => ({ rows: registrations.map(record => ({ record })) }), release: () => {},
    }),
  } as unknown as pg.Pool
  const sources: FleetSources = {
    codexUserMcpServers: async () => ({ docs: { url: 'https://docs.example/mcp' } }),
    claudeUserMcpServers: async () => ({}),
    codexPlugins: async () => [],
    codexMarketplaces: async () => [],
    claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
  }
  const requested: MaintenanceTaskStart[] = []
  const endpoint = {
    capabilities: () => [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true }],
    request: async (_device: string, _namespace: string, payload: unknown) => {
      const request = MaintenanceRequestSchema.parse(payload)
      if (request.operation === 'status') {
        return { payload: { operation: 'status', status: await computer.maintenance.status(AbortSignal.timeout(1000)) } }
      }
      requested.push(request.task)
      return { payload: { operation: 'start', task: await computer.maintenance.start(request.task, request.commandId) } }
    },
  }
  const createFleet = () => new FleetMaintenanceService(pool, mainId, () => endpoint,
    {} as PostgresCommandCoordinator, computer.maintenance, sources, now)
  return { fleet: createFleet(), createFleet, sources, requested, endpoint, registrations }
}
