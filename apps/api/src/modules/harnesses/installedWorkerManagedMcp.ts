import { mkdir, open, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appLauncherPath, installManagedLauncher } from './appMcpLauncher.js'
import { CodexMcpConnections } from './codexMcpConnections.js'
import { ClaudeMcpConnections } from './claudeMcpConnections.js'
import { WorkerManagedMcp } from './workerManagedMcp.js'
import type { ResolvedProviderAccount } from '../provider-accounts/service.js'
import { managedProviderEnvironment } from './providerAccountRuntime.js'
import { DomainError } from '../errors.js'
import { installedHarnessSelection, readInstalledWorkflowConfiguration,
  type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import { fingerprint, type NativeMcpAdapter, type NativeMcpSnapshot } from './nativeMcpCommon.js'

async function fileRevision(file: string) {
  try {
    const value = await stat(file, { bigint: true })
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Uses the Worker's own home, native binaries and packaged launcher, never paths supplied by Main. */
export function createInstalledWorkerManagedMcp(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation
  availableConfiguration(): InstalledWorkflowConfigurationLocation | null
  registry: NativeProcessRegistry
  launcherSource?: URL | undefined
  account?: ResolvedProviderAccount
}) {
  const environment = input.account ? managedProviderEnvironment(process.env, input.account, 'codex') : process.env
  const home = environment.HOME ?? homedir()
  const codexFile = join(environment.CODEX_HOME ?? join(home, '.codex'), 'config.toml')
  const claudeFile = join(environment.CLAUDE_CONFIG_DIR ?? home, '.claude.json')
  const inspectedFiles = new Set([codexFile, claudeFile])
  let observedRevision: string | undefined
  let readyRevision: string | undefined
  let active: Promise<void> = Promise.resolve()
  async function revision() {
    const configuration = await readInstalledWorkflowConfiguration(input.availableConfiguration())
    const launcher = appLauncherPath()
    const files = [...inspectedFiles, launcher, `${launcher}.installation.json`, `${launcher}.registration.json`,
      process.execPath, ...(configuration?.codexBinary ? [configuration.codexBinary] : [])]
    return fingerprint([configuration, files, await Promise.all(files.map(fileRevision))])
  }
  async function inspect(work: () => Promise<NativeMcpSnapshot>) {
    const before = await revision()
    const snapshot = await work()
    inspectedFiles.add(snapshot.file)
    const after = await revision()
    observedRevision = before === after ? after : undefined
    return snapshot
  }
  const installLauncher = (signal: AbortSignal) => installManagedLauncher(
    input.launcherSource ?? new URL('../../../../../scripts/graphql-mcp.mjs', import.meta.url), appLauncherPath(), signal)
  const codex: NativeMcpAdapter = {
    async read(signal) {
      return inspect(() => controlCodex(adapter => adapter.read(signal)))
    },
    async apply(snapshot, change, signal, managed) {
      readyRevision = undefined
      return controlCodex(adapter => adapter.apply(snapshot, change, signal, managed))
    },
  }
  async function controlCodex<T>(work: (adapter: NativeMcpAdapter) => Promise<T>): Promise<T> {
    const configuration = await readInstalledWorkflowConfiguration(input.configuration)
    const selection = configuration && installedHarnessSelection(configuration)
    if (!selection) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'Codex is not installed on this computer.', 409)
    const owner = `managed-mcp:codex:${randomUUID()}`
    const adapter = new CodexMcpConnections(selection.binary, input.stateDirectory,
      input.registry.scope(owner), installLauncher, environment)
    try {
      return await work(adapter)
    } finally {
      await input.registry.closeOwner(owner)
    }
  }
  const nativeClaude = new ClaudeMcpConnections(claudeFile)
  const claude: NativeMcpAdapter = {
    read: signal => inspect(() => nativeClaude.read(signal)),
    apply(snapshot, change, signal, managed) {
      readyRevision = undefined
      return nativeClaude.apply(snapshot, change, signal, managed)
    },
  }
  async function prepare(harness: 'codex' | 'claude') {
    if (harness !== 'codex') return
    const file = codexFile
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    try { await (await open(file, 'wx', 0o600)).close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const worker = new WorkerManagedMcp({ directory: input.stateDirectory, adapters: { codex, claude }, installLauncher, prepare })
  async function ensureReady(options: { signal?: AbortSignal }) {
    options.signal?.throwIfAborted()
    const configuration = await readInstalledWorkflowConfiguration(input.availableConfiguration())
    const harnesses: ('codex' | 'claude')[] = []
    if (configuration && installedHarnessSelection(configuration)) harnesses.push('codex')
    if (configuration?.claude && !input.account) harnesses.push('claude')
    if (!harnesses.length) return
    const before = await revision()
    if (before === readyRevision) return
    readyRevision = undefined
    await worker.ensureReady(harnesses, options)
    options.signal?.throwIfAborted()
    const after = await revision()
    // Only cache the configuration observed by native readback; edits racing setup retry normally.
    if (after === observedRevision) readyRevision = after
  }
  const accounts = new Map<string, { ensureReady(options: { signal?: AbortSignal }): Promise<void> }>()
  return { worker, ensureReady(options: { signal?: AbortSignal; account?: ResolvedProviderAccount } = {}): Promise<void> {
    if (options.account) {
      const key = fingerprint(options.account)
      let selected = accounts.get(key)
      if (!selected) {
        selected = createInstalledWorkerManagedMcp({ ...input,
          stateDirectory: join(input.stateDirectory, 'managed-account-mcp', options.account.accountId),
          account: options.account })
        accounts.set(key, selected)
      }
      const accountSetup = selected
      return mkdir(join(input.stateDirectory, 'managed-account-mcp', options.account.accountId),
        { recursive: true, mode: 0o700 }).then(() => accountSetup.ensureReady(options.signal ? { signal: options.signal } : {}))
    }
    const task = active.then(() => ensureReady(options), () => ensureReady(options))
    active = task
    return task
  } }
}
