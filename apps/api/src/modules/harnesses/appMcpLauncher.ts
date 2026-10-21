import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { appMcpDirectory } from '@foreman-code/contracts/product-environment-node'
import type { HarnessMcpConnection } from '@foreman-code/contracts/management'
import { APP_MCP_SERVER_NAMES, APP_MCP_TOKEN_NAMES, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { workerMcpRequestBudgetMs } from '../devices/workerMcpDeadline.js'
import { bootIdentity } from './recovery/linuxIdentity.js'

/** One native entry serves every role; the credential decides Operator, Orchestrator or Coder. */
export const APP_MCP_SERVER_NAME = PRODUCT_SLUG
export const APP_MCP_TOKEN = 'FOREMAN_CODE_MCP_TOKEN'
/** Leave twenty seconds after the relay budgets for local HTTP and native reply delivery. */
export const APP_MCP_TIMEOUTS = {
  startup_timeout_sec: 60,
  tool_timeout_sec: Math.ceil((workerMcpRequestBudgetMs + 20_000) / 1000),
} as const
export const isSupportedAppMcpServerName = (name: string): name is (typeof APP_MCP_SERVER_NAMES)[number] =>
  APP_MCP_SERVER_NAMES.some((supported) => supported === name)
export const isSupportedAppMcpTokenName = (name: string | undefined): name is (typeof APP_MCP_TOKEN_NAMES)[number] =>
  name !== undefined && APP_MCP_TOKEN_NAMES.some((supported) => supported === name)
export function appMcpServerName(entries: Readonly<Record<string, unknown>>, requested: string = APP_MCP_SERVER_NAME): string {
  if (!isSupportedAppMcpServerName(requested)) return requested
  const configured = APP_MCP_SERVER_NAMES.filter((name) => Object.hasOwn(entries, name))
  if (configured.length > 1) throw new Error('Both foreman-code and graphql MCP entries are configured. Resolve the naming collision at the native source.')
  return configured[0] ?? requested
}
export function appLauncherTokenName(entry: Record<string, unknown>): string | undefined {
  const names = entry.env_vars
  if (!Array.isArray(names) || names.length !== 1 || !isSupportedAppMcpTokenName(names[0])) return undefined
  return names[0] as string
}
export const APP_MCP_PATH = '/mcp'
/** Pre-unification entries. Recognized only so they can be reported and removed. */
export const LEGACY_APP_MCP_SERVER_NAMES = ['graphql-app', 'graphql-operator'] as const
export const chatExcludedAppMcpServerNames = (serverName: string): readonly string[] =>
  [...new Set([serverName, ...APP_MCP_SERVER_NAMES, ...LEGACY_APP_MCP_SERVER_NAMES])]
export function appLauncherPath(): string {
  return join(appMcpDirectory(), 'launcher.mjs')
}
export function appLauncherConnection(): Extract<HarnessMcpConnection, { transport: 'stdio' }> {
  return { transport: 'stdio', executable: process.execPath, arguments: [appLauncherPath()], environmentVariables: [APP_MCP_TOKEN] }
}
export interface LauncherInstallation {
  version: 1
  executables: { path: string; realpath: string }[]
  launcherAliases?: string[]
}
function installationPath(launcher: string): string { return `${launcher}.installation.json` }
function registrationPath(launcher: string): string { return `${launcher}.registration.json` }
function readInstallationRecord(path: string): LauncherInstallation | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as LauncherInstallation
    if (value?.version === 1 && Array.isArray(value.executables)
      && value.executables.every((entry) => typeof entry?.path === 'string' && typeof entry.realpath === 'string')
      && (value.launcherAliases === undefined || Array.isArray(value.launcherAliases)
        && value.launcherAliases.every((alias) => typeof alias === 'string' && isAbsolute(alias)))) return value
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return undefined
}
function mergeInstallations(current: LauncherInstallation | undefined, added: LauncherInstallation): LauncherInstallation {
  const executables = [...(current?.executables ?? [])]
  for (const executable of added.executables) {
    if (!executables.some((entry) => entry.path === executable.path && entry.realpath === executable.realpath)) {
      executables.push(executable)
    }
  }
  const launcherAliases = [...new Set([...(current?.launcherAliases ?? []), ...(added.launcherAliases ?? [])])]
  return { version: 1, executables, ...(launcherAliases.length ? { launcherAliases } : {}) }
}
export function readLauncherInstallation(launcher: string): LauncherInstallation | undefined {
  const installation = readInstallationRecord(installationPath(launcher))
  const registration = readInstallationRecord(registrationPath(launcher))
  return registration ? mergeInstallations(installation, registration) : installation
}
/** Only exact installed commands or the current runtime can identify an app launcher.
 * Legacy entries can match the current runtime (including canonical aliases); an
 * unrecorded different runtime needs explicit native removal and managed reinstall.
 * Native configuration ownership and credential-reference proof remain the caller's responsibility.
 */
export function isManagedLauncherCommand(command: unknown, launcher: string): boolean {
  if (!Array.isArray(command) || command.length !== 2 || command[1] !== launcher || typeof command[0] !== 'string') return false
  if (command[0] === process.execPath) return true
  try {
    const executable = realpathSync(command[0])
    if (executable === realpathSync(process.execPath)) return true
    return readLauncherInstallation(launcher)?.executables
      .some((entry) => entry.path === command[0] && entry.realpath === executable) ?? false
  } catch { return false }
}
function isAppLauncherCommand(command: unknown): boolean {
  const launcher = appLauncherPath()
  if (isManagedLauncherCommand(command, launcher)) return true
  if (!Array.isArray(command) || typeof command[1] !== 'string') return false
  const alias = command[1]
  if (!readLauncherInstallation(launcher)?.launcherAliases?.includes(alias)) return false
  try {
    return realpathSync(dirname(alias)) === realpathSync(dirname(launcher))
      && realpathSync(alias) === realpathSync(launcher) && isManagedLauncherCommand(command, alias)
  } catch { return false }
}
export function isAppLauncher(entry: Record<string, unknown>): boolean {
  const command = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
  if (!isAppLauncherCommand(command)) return false
  if (entry.url != null || entry.bearer_token_env_var != null || entry.oauth != null
    || (entry.headers != null && Object.keys(entry.headers as object).length > 0)
    || (entry.http_headers != null && Object.keys(entry.http_headers as object).length > 0)
    || (entry.env_http_headers != null && Object.keys(entry.env_http_headers as object).length > 0)) return false
  const tokenName = appLauncherTokenName(entry)
  return (!entry.env || Object.keys(entry.env as object).length === 0) && tokenName !== undefined
}
/** This app's launcher entry whose recorded Node interpreter no longer exists (removed or upgraded). Its
 * transport is otherwise exactly the managed launcher, so repair may replace the interpreter. */
export function isStaleAppLauncher(entry: Record<string, unknown>): boolean {
  const args = Array.isArray(entry.args) ? entry.args : []
  if (typeof entry.command !== 'string' || !isAbsolute(entry.command) || args.length !== 1 || args[0] !== appLauncherPath()
    || existsSync(entry.command)) return false
  return isAppLauncher({ ...entry, command: process.execPath })
}
export async function installAppLauncher(signal?: AbortSignal): Promise<void> {
  await installManagedLauncher(new URL('../../../../../scripts/graphql-mcp.mjs', import.meta.url), appLauncherPath(), signal)
}
export async function installManagedLauncher(sourceUrl: URL, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const source = await readFile(sourceUrl, 'utf8')
  await withLauncherLock(destination, async (installationSignal) => {
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      installationSignal.throwIfAborted()
      await writeFile(temporary, source, { mode: 0o600, flag: 'wx' })
      installationSignal.throwIfAborted()
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
    await saveLauncherInstallation(destination, {
      version: 1,
      executables: [{ path: process.execPath, realpath: realpathSync(process.execPath) }],
    }, installationSignal)
  }, signal)
}
export async function writeLauncherInstallation(
  destination: string, installation: LauncherInstallation, signal?: AbortSignal,
): Promise<void> {
  await withLauncherLock(destination, (installationSignal) =>
    saveLauncherInstallation(destination, installation, installationSignal), signal)
}
async function withLauncherLock<T>(
  destination: string, action: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.timeout(60_000)
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline
  signal.throwIfAborted()
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const directory = await open(dirname(destination), 'r')
  try {
    signal.throwIfAborted()
    // Directory aliases share the same inode; the kernel releases the lock on process exit.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', directory.fd],
      })
      let processError: Error | undefined
      const abort = () => { child.kill('SIGKILL') }
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', error => { processError = error })
      child.once('close', code => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(signal.reason)
        else if (processError) reject(processError)
        else if (code === 0) resolve()
        else reject(new Error('MCP launcher installation lock failed.'))
      })
      if (signal.aborted) abort()
    })
    signal.throwIfAborted()
    return await action(signal)
  } finally {
    await directory.close()
  }
}
async function saveLauncherInstallation(
  destination: string, installation: LauncherInstallation, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const merged = mergeInstallations(readLauncherInstallation(destination), installation)
  // Older APIs replace installation.json without preserving aliases or concurrent registrations.
  await writeInstallationRecord(registrationPath(destination), merged, signal)
  await writeInstallationRecord(installationPath(destination), merged, signal)
}
async function writeInstallationRecord(
  metadata: string, installation: LauncherInstallation, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const pending = `${metadata}.${randomUUID()}.tmp`
  try {
    const file = await open(pending, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(installation))
      await file.sync()
    } finally {
      await file.close()
    }
    signal.throwIfAborted()
    await rename(pending, metadata)
    const directory = await open(dirname(metadata), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(pending, { force: true })
  }
}
export interface AppMcpRouteOwnership {
  runtimeEpoch: string
  assertActive(): void
}

export type AppMcpRouteRegistration = (() => Promise<void>) & {
  refresh(expiresAt: string, signal?: AbortSignal): Promise<void>
}

interface AppMcpRouteOptions {
  now?: () => number
  renewalFailure?: string
  signal?: AbortSignal | undefined
}

/** The local launcher shares this boot's monotonic clock, even when lease timestamps come from Main. */
function routeMonotonicExpiry(expiresAt: string, now: () => number) {
  const elapsed = process.hrtime.bigint()
  const remainingMs = Date.parse(expiresAt) - now()
  return { bootId: bootIdentity(), nanoseconds: (elapsed + BigInt(Math.floor(remainingMs * 1_000_000))).toString() }
}

/** `renewalFailure` records why the route's lease stopped renewing; the launcher reports it once the route expires. */
export async function registerAppRoute(
  token: string, endpoint: string, expiresAt: string, launcher = appLauncherPath(), options: AppMcpRouteOptions = {},
): Promise<AppMcpRouteRegistration> {
  return registerAppRouteDigest(createHash('sha256').update(token).digest('hex'), endpoint, expiresAt, launcher,
    undefined, options)
}

export async function registerAppRouteDigest(
  digest: string, endpoint: string, expiresAt: string, launcher = appLauncherPath(), ownership?: AppMcpRouteOwnership,
  options: AppMcpRouteOptions = {},
): Promise<AppMcpRouteRegistration> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid Foreman Code MCP route identity.')
  const directory = join(dirname(launcher), 'routes')
  const file = join(directory, `${digest}.json`)
  const registrationId = randomUUID()
  const runtimeEpoch = ownership?.runtimeEpoch ?? randomUUID()
  const ownsRoute = async (): Promise<boolean> => {
    try {
      const current = JSON.parse(await readFile(file, 'utf8')) as { registrationId?: string; runtimeEpoch?: string }
      return current.registrationId === registrationId && current.runtimeEpoch === runtimeEpoch
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const publish = (expiration: string, mode: 'register' | 'refresh',
    publication: Pick<AppMcpRouteOptions, 'renewalFailure' | 'signal'> = {}): Promise<void> =>
    withLauncherLock(launcher, async signal => {
      ownership?.assertActive()
      if (mode === 'refresh' && !await ownsRoute()) return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ endpoint, expiresAt: expiration, pid: process.pid,
          toolTimeoutMs: APP_MCP_TIMEOUTS.tool_timeout_sec * 1000,
          ...(options.now ? { monotonicExpiry: routeMonotonicExpiry(expiration, options.now) } : {}),
          registrationId, runtimeEpoch,
          ...(publication.renewalFailure ? { renewalFailure: publication.renewalFailure } : {}) }), { mode: 0o600, flag: 'wx' })
        signal.throwIfAborted()
        ownership?.assertActive()
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
    }, publication.signal)
  await publish(expiresAt, 'register', options)
  const remove = async (): Promise<void> => {
    await withLauncherLock(launcher, async () => {
      if (await ownsRoute()) await rm(file, { force: true })
    })
  }
  return Object.assign(remove, {
    refresh: (expiration: string, signal?: AbortSignal) => publish(expiration, 'refresh', { signal }),
  })
}
