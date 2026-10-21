import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { MaintenancePorts } from './maintenancePorts.js'
import {
  readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation,
} from '../runs/remote/installedWorkflowConfiguration.js'

/** Where `npm install --global --prefix ~/.local @openai/codex` puts the platform's native Codex binaries. */
function nativeCodexScope(home: string) {
  return join(home, '.local', 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai')
}

async function installedNativeCodex(home: string): Promise<string> {
  const scope = nativeCodexScope(home)
  const candidates: string[] = []
  const absent = (error: unknown): string[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  for (const entry of await readdir(scope).catch(absent)) {
    if (!entry.startsWith('codex-')) continue
    const vendor = join(scope, entry, 'vendor')
    for (const triple of await readdir(vendor).catch(absent)) candidates.push(join(vendor, triple, 'bin', 'codex'))
  }
  const executable = (await Promise.all(candidates.map(candidate =>
    access(candidate, constants.X_OK).then(() => candidate, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })))).filter((value): value is string => value !== null)
  if (executable.length !== 1) {
    throw new Error(`The updated Codex binary could not be located: ${executable.length} executable candidates from ${candidates.length} paths.`)
  }
  return executable[0]!
}

function reportedVersion(binary: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { signal, timeout: 15_000, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout) => {
        const version = stdout.trim()
        if (error || !/^codex-cli \d+\.\d+\.\d+/u.test(version)) reject(new Error('The updated Codex binary did not report its version.'))
        else resolve(version)
      })
  })
}

const MainSelectionSchema = z.object({
  configuredBinary: z.string().min(1),
  binary: z.string().startsWith('/'),
}).strict()

/** Main consumers share this selection; their existing qualification checks still inspect the selected binary. */
export class MainCodexSelection {
  private selected: string
  constructor(private readonly configuredBinary: string, private readonly path: string,
    private readonly ports: Pick<MaintenancePorts, 'environment' | 'readText' | 'writePrivateText'>) {
    this.selected = configuredBinary
  }

  get binary(): string { return this.selected }

  async initialize(): Promise<void> {
    const text = await this.ports.readText(this.path)
    if (!text) return
    const saved = MainSelectionSchema.parse(JSON.parse(text))
    if (saved.configuredBinary !== this.configuredBinary) return
    await reportedVersion(saved.binary, AbortSignal.timeout(15_000))
    this.selected = saved.binary
  }

  async selectInstalled(signal: AbortSignal): Promise<string> {
    const home = this.ports.environment.HOME ?? homedir()
    const binary = await installedNativeCodex(home)
    await reportedVersion(binary, signal)
    await this.ports.writePrivateText(this.path, `${JSON.stringify({ configuredBinary: this.configuredBinary, binary })}\n`)
    this.selected = binary
    return binary
  }
}

/**
 * Moves a Worker's installer-selected Codex to the Codex that maintenance just installed, so new work actually runs the
 * update. Only the binary selection changes: qualification still checks the exact binary before any profile uses it.
 * Returns null when the Worker has no Codex selection (it then uses the maintained Codex on PATH).
 */
export async function selectInstalledCodex(location: InstalledWorkflowConfigurationLocation | null, home: string,
  signal: AbortSignal): Promise<string | null> {
  if (!location) return null
  const configuration = await readInstalledWorkflowConfiguration(location)
  if (!configuration?.codexBinary) return null
  const binary = await installedNativeCodex(home)
  const expectedVersion = await reportedVersion(binary, signal)
  if (configuration.codexBinary === binary && configuration.expectedVersion === expectedVersion) return binary
  const next = { ...configuration, codexBinary: binary, expectedVersion, payloadPaths: [] }
  // The reader requires a private, single-link file; write a new one and rename it over the old selection.
  const temporary = join(dirname(location.path), `.workflow-runtime.${randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(`${JSON.stringify(next, null, 2)}\n`)
    await file.sync()
  } finally { await file.close() }
  try { await rename(temporary, location.path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
  return binary
}
