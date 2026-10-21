import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { finished } from 'node:stream/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import { spawnOwnedStdioProcess } from '../process.js'
import { passiveDriverPayloads } from '../payloadDiscovery.js'
import { discoverLauncher } from '../hostDiscovery.js'
import { CompatibilityCheckError } from './errors.js'

export interface HarnessInstallation {
  executable: string
  identity: string
  version: string
  installationFingerprint?: string
  payloadPaths?: string[]
}
export interface CompatibilityProbe {
  /** Version commands own their deadline; installation verification and cleanup also observe cancellation. */
  inspect(harness: CompatibilityHarness, signal: AbortSignal, attempt?: number): Promise<HarnessInstallation>
  probe(harness: CompatibilityHarness, installation: HarnessInstallation, signal: AbortSignal): Promise<string>
  assertUnchanged(installation: HarnessInstallation, signal: AbortSignal): Promise<void>
  close?(): Promise<void>
}
export interface CompatibilityProbeOwnership {
  recovery: NativeProcessRecovery
  beforeCommand(binary: string, signal: AbortSignal): Promise<void>
}
type DiagnosticProcess = Awaited<ReturnType<typeof spawnOwnedStdioProcess>>
const EXPORT_LIMIT = 16 * 1024 * 1024
const unavailable = () => new CompatibilityCheckError('CLI_UNAVAILABLE', 'The configured CLI could not be found or executed. Repair that installation; no other harness was substituted.')

export function parseInstalledVersion(stdout: string, stderr: string): string {
  const value = (stdout.trim() || stderr.trim())
  const semver = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?'
  const prefix = 'codex-cli '
  if (!new RegExp(`^${prefix}${semver}$`).test(value) || value.length > 100) {
    throw new CompatibilityCheckError('CLI_VERSION_INVALID', 'The configured CLI returned an unrecognized version. Check the binary setting and retry.')
  }
  return value.slice(prefix.length)
}
export function diagnosticEnvironment(directory: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Do NOT inherit model/API tokens, NODE_OPTIONS, native configuration overrides,
  // plugin settings, app credentials, proxy secrets, or the real home directory.
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return {
    ...environment, HOME: directory, USERPROFILE: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'),
    CODEX_HOME: join(directory, 'codex'),
    CI: '1', NO_COLOR: '1', TERM: 'dumb',
  }
}
export function schemaExportArguments(directory: string): string[] {
  return ['app-server', 'generate-json-schema', '--experimental', '--out', join(directory, 'schemas')]
}
async function executable(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const paths = isAbsolute(binary) || binary.includes('/') || binary.includes('\\')
    ? [resolve(cwd, binary)]
    : (environment.PATH ?? '').split(delimiter).flatMap((directory) => {
      const base = resolve(cwd, directory || '.', binary)
      return process.platform === 'win32' && !/\.[a-z]+$/i.test(binary)
        ? (environment.PATHEXT ?? '.EXE;.COM').split(';').map((extension) => base + extension.toLowerCase()) : [base]
    })
  for (const candidate of paths) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate) } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw unavailable()
}
async function fingerprint(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const before = await stat(path)
  if (!before.isFile()) throw unavailable()
  // Package-store hardlinks change ctime; content and launch-relevant metadata define this installation.
  const metadata = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.mtimeMs]
  const hash = createHash('sha256')
  // Streaming keeps large native executables out of memory and observes cancellation.
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  const after = await stat(path)
  if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after))) {
    throw new CompatibilityCheckError('CLI_CHANGED', 'The CLI changed during inspection. Retry after the installation has finished.')
  }
  return createHash('sha256').update(JSON.stringify([await realpath(path), metadata(after), hash.digest('hex')])).digest('hex')
}

async function installationIdentity(binary: string, payloadPaths: readonly string[], signal: AbortSignal): Promise<string> {
  const paths = [...new Set([binary, ...payloadPaths])].sort()
  const fingerprints = await Promise.all(paths.map(path => fingerprint(path, signal)))
  return createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex')
}

/** Only fixed version/schema commands call this. No shell, credentials, stdin prompts, or server. */
async function command(binary: string, args: string[], directory: string, environment: NodeJS.ProcessEnv,
  signal: AbortSignal, limit: number, processes: Set<DiagnosticProcess>,
  ownership?: CompatibilityProbeOwnership, timeoutMs?: number) {
  signal.throwIfAborted()
  await ownership?.beforeCommand(binary, signal)
  signal.throwIfAborted()
  // Identity hashing must finish before the native command's launch budget starts.
  if (timeoutMs !== undefined) signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  let rejectFailure: (error: unknown) => void = () => undefined
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject })
  void failure.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
  const owned = await spawnOwnedStdioProcess({ binary, args, cwd: directory, environment, signal,
    preserveReadableDrain: true,
    ...(ownership ? { recovery: ownership.recovery } : {}),
    onError: () => rejectFailure(unavailable()),
  })
  processes.add(owned)
  let stdout = ''; let stderr = ''; let bytes = 0
  const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > limit) {
      rejectFailure(new CompatibilityCheckError('CLI_OUTPUT_LIMIT', 'The CLI export exceeded the diagnostic output limit. Review this release before qualifying it.'))
      void owned.close().catch(rejectFailure)
      return
    }
    if (target === 'stdout') stdout += chunk.toString('utf8')
    else stderr += chunk.toString('utf8')
  }
  // Generated JSON is UTF-8; setEncoding preserves characters split between chunks.
  owned.child.stdout.setEncoding('utf8'); owned.child.stderr.setEncoding('utf8')
  owned.child.stdout.on('data', (chunk: string) => collect('stdout', Buffer.from(chunk)))
  owned.child.stderr.on('data', (chunk: string) => collect('stderr', Buffer.from(chunk)))
  const completed = Promise.all([
    owned.closed,
    finished(owned.child.stdout, { readable: true, writable: false, cleanup: true }),
    finished(owned.child.stderr, { readable: true, writable: false, cleanup: true }),
  ]).then(([result]) => result)
  const abort = () => { rejectFailure(signal.reason); void owned.close().catch(rejectFailure) }
  const closeOwned = async () => {
    try { await owned.close(); processes.delete(owned) } catch {
      throw new CompatibilityCheckError('CLI_CLEANUP_FAILED', 'The diagnostic process did not confirm clean shutdown. Check the CLI process before retrying.')
    }
  }
  signal.addEventListener('abort', abort, { once: true })
  owned.child.stdin.end()
  if (signal.aborted) abort()
  try {
    const result = await Promise.race([completed, failure])
    signal.throwIfAborted()
    if (result.exitCode !== 0) {
      if (ownership && stderr.includes('Native launch refused: delegated cgroup v2 with cgroup.kill is required.')) {
        throw new CompatibilityCheckError('NATIVE_CONTAINMENT_UNAVAILABLE',
          'Native diagnostics require a delegated cgroup v2 with cgroup.kill. '
          + 'Run the application or tests in their delegated service or scope and retry.')
      }
      throw new CompatibilityCheckError('CLI_CHECK_REJECTED',
        'The CLI rejected its version/schema export command. The release may not support this diagnostic. Review the installation and retry.')
    }
    return { stdout, stderr }
  } finally {
    signal.removeEventListener('abort', abort)
    await closeOwned()
  }
}
async function isolated<T>(source: NodeJS.ProcessEnv, directories: Set<string>, work: (directory: string, environment: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-compatibility-'))
  directories.add(directory)
  let retain = false
  try {
    await Promise.all(['config', 'cache', 'data', 'state', 'codex'].map((name) => mkdir(join(directory, name), { mode: 0o700 })))
    return await work(directory, diagnosticEnvironment(directory, source))
  } catch (error) {
    retain = error instanceof CompatibilityCheckError && error.code === 'CLI_CLEANUP_FAILED'
    throw error
  } finally {
    if (!retain) { await rm(directory, { recursive: true, force: true }); directories.delete(directory) }
  }
}
async function readExport(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > EXPORT_LIMIT) throw new Error('Invalid export file.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const bytes = Buffer.alloc(EXPORT_LIMIT + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > EXPORT_LIMIT) throw new Error('Export limit exceeded.')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
}
export function nativeCompatibilityProbe(binaries: Record<CompatibilityHarness, string>, workingDirectory: string, source: NodeJS.ProcessEnv = process.env, inspectTimeoutMs = 2000, ownership?: CompatibilityProbeOwnership): CompatibilityProbe {
  const processes = new Set<DiagnosticProcess>()
  const directories = new Set<string>()
  return {
    async inspect(harness, signal, attempt = 1) {
      const resolved = await executable(binaries[harness], workingDirectory, source)
      const payload = await passiveDriverPayloads(harness, resolved)
      const launcher = await discoverLauncher(resolved, { path: source.PATH ?? '', cwd: workingDirectory,
        provenance: 'terminal', generation: 'compatibility-inspection' }, [], signal)
      const payloadPaths = [...payload.paths, ...(launcher.interpreter ? [launcher.interpreter] : [])]
      const identity = await installationIdentity(resolved, payloadPaths, signal)
      const version = await isolated(source, directories, async (directory, environment) => {
        const output = await command(resolved, ['--version'], directory, environment,
          signal, 4096, processes, ownership, attempt === 1 ? inspectTimeoutMs : Math.max(inspectTimeoutMs, 10_000))
        return parseInstalledVersion(output.stdout, output.stderr)
      })
      return { executable: resolved, identity, version, payloadPaths }
    },
    async probe(harness, installation, signal) {
      return isolated(source, directories, async (directory, environment) => {
        try {
          await command(installation.executable, schemaExportArguments(directory), directory, environment, signal, EXPORT_LIMIT, processes, ownership)
        } catch (error) {
          if (error instanceof CompatibilityCheckError && error.code === 'CLI_CHECK_REJECTED') {
            const contract = 'app-server generate-json-schema --experimental'
            throw new CompatibilityCheckError(error.code,
              `${harness} ${installation.version} could not complete the required ${contract} schema export contract.`, { cause: error })
          }
          throw error
        }
        const text = await readExport(join(directory, 'schemas', 'codex_app_server_protocol.schemas.json'))
        signal.throwIfAborted()
        const input = join(directory, 'diagnostic-schema.json')
        await writeFile(input, text, { flag: 'wx', mode: 0o600 })
        let result: unknown
        try {
          const development = import.meta.url.endsWith('.ts')
          let extension = 'js'
          if (development) extension = 'ts'
          else if (import.meta.url.endsWith('.mjs')) extension = 'mjs'
          const worker = fileURLToPath(new URL(`./schemaWorker.${extension}`, import.meta.url))
          const args = development ? ['--import', createRequire(import.meta.url).resolve('tsx'), worker] : [worker]
          const checked = await command(process.execPath, [...args, harness, input], directory, environment, signal, 4096, processes, ownership)
          result = JSON.parse(checked.stdout)
        } catch (error) {
          if (signal.aborted || (error instanceof CompatibilityCheckError
            && !['CLI_UNAVAILABLE', 'CLI_CHECK_REJECTED'].includes(error.code))) throw error
          throw new CompatibilityCheckError('CHECKER_UNAVAILABLE',
            'The application schema checker could not finish. Rebuild the API and retry; do not switch harnesses to work around this error.', { cause: error })
        }
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
          throw new CompatibilityCheckError('PROTOCOL_SETTINGS_UNSUPPORTED',
            `${harness} ${installation.version}: ${'contract' in result && typeof result.contract === 'string' ? result.contract : 'Required protocol/settings contract is unavailable.'}`)
        }
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
          || !('schemaSha256' in result) || typeof result.schemaSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.schemaSha256)) {
          throw new CompatibilityCheckError('CHECKER_OUTPUT_INVALID', 'The application schema checker returned an invalid result. Rebuild the API and retry.')
        }
        signal.throwIfAborted()
        return result.schemaSha256
      })
    },
    async assertUnchanged(installation, signal) {
      if (await installationIdentity(installation.executable, installation.payloadPaths ?? [], signal) !== installation.identity) {
        throw new CompatibilityCheckError('CLI_CHANGED', 'The CLI changed while it was checked. Retry after the installation has finished.')
      }
    },
    async close() {
      const results = await Promise.allSettled([...processes].map(async (owned) => {
        await owned.close(); processes.delete(owned)
      }))
      if (results.some((result) => result.status === 'rejected')) {
        throw new CompatibilityCheckError('CLI_CLEANUP_FAILED', 'Diagnostic process shutdown is unconfirmed; ownership was retained for a later cleanup attempt.')
      }
      await Promise.all([...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true }); directories.delete(directory)
      }))
    },
  }
}
