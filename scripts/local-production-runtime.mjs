import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { readProductEnvironment, resolveProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { productionMaintenanceKey } from '../packages/contracts/src/productionMaintenance.mjs'

export function parseRunWaitMinutes(value) {
  const minutes = value === undefined ? 120 : Number(value)
  const timeoutMs = minutes * 60_000
  if ((value !== undefined && !value.trim()) || !Number.isFinite(timeoutMs) || minutes < 0) {
    throw new Error('FOREMAN_INSTALL_RUN_WAIT_MINUTES must be a finite, nonnegative number of minutes.')
  }
  return timeoutMs
}

export async function readReleaseSelection(current) {
  try {
    return await realpath(current)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
}

export async function needsStartupConfiguration(stateFile, { previousRelease } = {}) {
  try {
    return !JSON.parse(await readFile(stateFile, 'utf8')).startupConfigured
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await publish(stateFile, JSON.stringify({ startupConfigured: Boolean(previousRelease) }) + '\n')
    return !previousRelease
  }
}

export async function recordStartupConfiguration(stateFile) {
  await publish(stateFile, JSON.stringify({ startupConfigured: true }) + '\n')
}

// Compiled output whose source file no longer exists; tsc --incremental never removes it.
const typeScriptOutputs = [['apps/api/dist', 'apps/api/src'], ['packages/contracts/dist', 'packages/contracts/src']]
const outputSuffix = /(\.d)?\.(?:m?js|ts|mts)(\.map)?$/

async function pruneStaleTypeScriptOutput(source, trackedSources) {
  for (const [output, input] of typeScriptOutputs) {
    const visit = async relative => {
      let entries
      try {
        entries = await readdir(join(source, output, relative), { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const path = join(relative, entry.name)
        if (entry.isDirectory()) {
          await visit(path)
          continue
        }
        if (!outputSuffix.test(entry.name)) continue
        const stem = path.replace(outputSuffix, '')
        const hasSource = ['.ts', '.tsx', '.mts', '.mjs', '.js']
          .some(extension => trackedSources.has(join(input, stem + extension)))
        if (!hasSource) await rm(join(source, output, path), { force: true })
      }
    }
    await visit('')
  }
}

// One persistent build tree per installation keeps installed dependencies and incremental TypeScript output
// between installs; every tracked file is reset to the exact commit and every other untracked file is removed.
export async function withProductionSourceSnapshot(repository, directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const source = join(directory, 'source')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const execute = promisify(execFile)
  const git = (args, cwd = repository) => execute('git', args, { cwd, env: environment, maxBuffer: 16 * 1024 * 1024 })
  const { stdout } = await git(['rev-parse', 'HEAD'])
  const commit = stdout.trim()
  const { stdout: origin } = await git(['remote', 'get-url', 'origin'])
  const present = await lstat(source).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const reusable = present && await git(['rev-parse', '--git-dir'], source).then(() => true)
  if (!reusable) {
    await rm(source, { recursive: true, force: true })
    await git(['clone', '--quiet', '--shared', '--no-checkout', repository, source])
  }
  // The shared clone reads the repository's objects, so any commit it has is available without a fetch.
  if (reusable) {
    const { stdout: changes } = await git(['diff', '--name-only', '-z', 'HEAD'], source)
    if (changes) await git(['reset', '--hard', '--quiet', 'HEAD'], source)
  }
  await git(['clean', '-ffdxq', '-e', 'node_modules', '-e', 'dist', '-e', '*.tsbuildinfo',
    '-e', '.logs/heavy-build-web.json'], source)
  // Forced checkout rewrites unchanged files and invalidates incremental build timestamps.
  await git(['checkout', '--quiet', '--detach', commit], source)
  await git(['remote', 'set-url', 'origin', origin.trim()], source)
  const { stdout: files } = await git(['ls-files', '-z', '--', ...typeScriptOutputs.map(([, input]) => input)], source)
  await pruneStaleTypeScriptOutput(source, new Set(files.split('\0')))
  return action({ source, commit })
}

export async function measureProductionStep(step, action, log = console.log) {
  const started = performance.now()
  try {
    return await action()
  } finally {
    log(JSON.stringify({ operation: 'production deploy', step, elapsedMs: Math.round(performance.now() - started) }))
  }
}

// The full API check overlaps emission, browser bundling and staging, and gates activation.
export async function buildProductionSource(run, { stage = async () => undefined } = {}) {
  await run('corepack', ['pnpm', '--filter', '@foreman-code/contracts', 'build'])
  const results = await Promise.allSettled([
    measureProductionStep('API full check', () => run('corepack', ['pnpm', '--filter', '@foreman-code/api',
      'exec', 'tsc', '-p', 'tsconfig.build.json', '--noEmit', '--isolatedModules',
      '--tsBuildInfoFile', 'node_modules/.cache/tsc/production-check.tsbuildinfo'])),
    (async () => {
      await measureProductionStep('API emit', () => run('node', ['scripts/emit-production-api.mjs']))
      await run('corepack', ['pnpm', '--filter', '@foreman-code/api', 'exec', 'node', '../../scripts/copy-api-runtime.mjs'])
      await run('corepack', ['pnpm', '--filter', '@foreman-code/api', 'exec', 'node', 'dist/cli/harnessCompatibility.js'])
      await measureProductionStep('web bundle', () => run('node', ['scripts/heavy-job.mjs', '--build', 'web', '--',
        'corepack', 'pnpm', '--filter', '@foreman-code/web', 'exec', 'vite', 'build']))
      return stage()
    })(),
  ])
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  return results[1].value
}

export async function findPendingMigrations({ migrations, query }) {
  const { rows } = await query("select to_regclass('application_migrations') is not null as present")
  if (!rows[0].present) return migrations.map(migration => migration.version)
  const applied = await query('select version from application_migrations')
  const appliedVersions = new Set(applied.rows.map(row => row.version))
  return migrations.filter(migration => !appliedVersions.has(migration.version)).map(migration => migration.version)
}

export async function readPendingMigrations(release, databaseUrl) {
  const { migrations } = await import(pathToFileURL(join(release, 'apps/api/dist/infrastructure/migrations.js')))
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 })
  try {
    return await findPendingMigrations({ migrations, query: text => pool.query(text) })
  } finally {
    await pool.end()
  }
}

async function readDeployment(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
}

async function saveDeployment(stateFile, state, phase) {
  state.phase = phase
  await publish(stateFile, JSON.stringify(state, null, 2) + '\n')
}

export async function recoverReleaseCutover({ stateFile, steps }) {
  const state = await readDeployment(stateFile)
  if (!state || ['ready', 'recovered'].includes(state.phase)) return
  if (state.apiMayHaveStopped === false) {
    await saveDeployment(stateFile, state, 'recovered')
    return
  }
  try {
    await saveDeployment(stateFile, state, 'recovering')
    await steps.stop()
    await steps.activate(state.previousRelease)
    if (state.previousRelease) {
      await steps.start()
      await steps.ready(state.previousRelease)
    }
    await saveDeployment(stateFile, state, 'recovered')
  } catch (error) {
    state.recoveryFailure = error.message
    let stopFailure
    try {
      await steps.stop()
    } catch (stopError) {
      stopFailure = stopError
      state.stopFailure = stopError.message
    }
    await saveDeployment(stateFile, state, 'recovery-failed')
    if (stopFailure) throw new AggregateError([error, stopFailure], 'Recovery and stopping the API failed.')
    throw error
  }
}

export async function runReleaseCutover({ release, previousRelease, stateFile, steps }) {
  const state = { release, previousRelease, apiMayHaveStopped: false }
  let recoveryAttempted = false
  const perform = async (phase, action) => {
    await saveDeployment(stateFile, state, phase)
    await measureProductionStep(phase, action)
  }
  const rollback = async error => {
    recoveryAttempted = true
    state.failure = error.message
    await saveDeployment(stateFile, state, state.phase)
    try {
      await recoverReleaseCutover({ stateFile, steps })
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError],
        `Release cutover and recovery failed. Retained deployment details: ${stateFile}`, { cause: error })
    }
  }
  try {
    await saveDeployment(stateFile, state, 'checking-migrations')
    const pendingMigrations = await measureProductionStep('checking-migrations', () => steps.pendingMigrations(release))
    state.apiMayHaveStopped = true
    await perform('stopping', steps.stop)
    if (pendingMigrations.length) {
      await perform('migrating', () => steps.migrate(release))
      await saveDeployment(stateFile, state, 'migrated')
    }
    await perform('upgrading-launcher', () => steps.upgradeLauncher(release))
    await perform('activating', () => steps.activate(release))
    const start = async () => {
      await perform('configuring-startup', steps.enable)
      await perform('starting', steps.start)
      await saveDeployment(stateFile, state, 'checking-readiness')
    }
    if (steps.checkReady) {
      await measureProductionStep('start-and-readiness', () => steps.checkReady(release, { start, rollback }))
    } else {
      await start()
      await measureProductionStep('checking-readiness', () => steps.ready(release))
    }
    await saveDeployment(stateFile, state, 'ready')
  } catch (error) {
    if (!recoveryAttempted) await rollback(error)
    throw error
  }
}

export function shouldOpenDashboardAfterInstall({ previousRelease, stdin, stdout }) {
  return !previousRelease && stdin.isTTY === true && stdout.isTTY === true
}

export function productionIntegrationPaths(home, environment) {
  const config = environment.XDG_CONFIG_HOME || join(home, '.config')
  const data = environment.XDG_DATA_HOME || join(home, '.local/share')
  if (!isAbsolute(config) || !isAbsolute(data)) {
    throw new Error('XDG_CONFIG_HOME and XDG_DATA_HOME must be absolute paths.')
  }
  return {
    units: join(config, 'systemd/user'),
    desktop: join(data, 'applications/graphql-production.desktop'),
    autostart: join(config, 'autostart/graphql-production.desktop'),
    icon: join(data, 'icons/hicolor/scalable/apps/graphql-production.svg'),
  }
}

export async function publishDesktopIntegration(paths, { desktop, autostart, icon, firstInstall }) {
  await publish(paths.icon, icon, 0o644)
  await publish(paths.desktop, desktop, 0o644)
  // Updates leave both deleted entries and user-edited startup preferences intact.
  if (firstInstall) await publish(paths.autostart, autostart, 0o644)
}

export async function enableProductionServices(run, units, { firstInstall }) {
  if (firstInstall) await run('/usr/bin/systemctl', ['--user', 'enable', ...units])
}

export function apiServiceTemplate(databaseUnit) {
  return `[Unit]
Description=Foreman Code production API and dashboard
Wants=${databaseUnit}
After=${databaseUnit}
StartLimitIntervalSec=0

[Service]
Type=exec
Delegate=yes
WorkingDirectory=@APP@/current/apps/api
EnvironmentFile=@HOME@/.config/graphql-production/production.env
Environment=FOREMAN_CODE_API_ENV_FILE=@HOME@/.config/graphql-production/production.env
# Keep SCRAM crypto responsive alongside overlapping eight-entry filesystem batches.
Environment=UV_THREADPOOL_SIZE=32
Environment=DATABASE_POOL_MAX=40
Environment=DATABASE_QUERY_TIMEOUT_MS=5000
Environment=FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY=@APP@/current/worker-artifacts
Environment=PATH=@PATH@
ExecStart=@NODE@ @APP@/current/apps/api/dist/server.js
ExecStartPost=@NODE@ @APP@/current/scripts/local-production.mjs health
ExecStartPost=/usr/bin/systemctl --user --no-block restart foreman-worker-publish.service
Restart=always
RestartSec=3
TimeoutStartSec=120
TimeoutStopSec=60
# Guardians retain their registered native cgroups across API restarts.
KillMode=process
UMask=0077

[Install]
WantedBy=default.target
`
}

export async function launchProduction({ lockPath, start, ready, openDashboard, timeoutMs = 90_000 }) {
  await withInstallationLock(lockPath, async () => {
    const deadline = Date.now() + timeoutMs
    let failure
    while (Date.now() < deadline) {
      try {
        await start()
        await ready(Math.min(2000, Math.max(1, deadline - Date.now())))
        await openDashboard()
        return
      } catch (error) {
        failure = error
        // A healthy backend with a failed browser handoff must not spawn repeated browsers.
        if (error.browserLaunchFailed) throw error
      }
      await delay(Math.min(500, Math.max(0, deadline - Date.now())))
    }
    throw new Error(`Foreman Code could not become ready. ${failure?.message ?? ''}`)
  }, { timeoutMs })
}

export function launchBrowser(command, args, { environment, observeMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: environment })
    let diagnostic = ''
    let timer
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stderr?.unref?.()
      child.unref()
      if (error) {
        error.browserLaunchFailed = true
        reject(error)
      } else resolve()
    }
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096) })
    child.once('error', () => finish(new Error('The backend is ready, but Chrome could not be started.')))
    child.once('exit', (code, signal) => {
      if (code === 0) return finish()
      let guidance = 'Check the desktop session and Chrome profile.'
      if (/display|X server|ozone_platform/i.test(diagnostic)) guidance = 'Check that a graphical desktop session is available.'
      else if (/Singleton|profile|ProcessSingleton/i.test(diagnostic)) guidance = 'Check that the Chrome profile is available.'
      finish(new Error(`The backend is ready, but Chrome exited (${signal ?? code}). ${guidance}`))
    })
    child.once('spawn', () => { timer = setTimeout(() => finish(), observeMs) })
  })
}

export function desktopLaunchEnvironment(source) {
  const environment = { ...source }
  if (!readProductEnvironment(source, 'HEAVY_JOB_TOKEN')) return environment
  const baseTemporaryDirectory = readProductEnvironment(source, 'HEAVY_BASE_TMPDIR')
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
    if (baseTemporaryDirectory) environment[name] = baseTemporaryDirectory
    else delete environment[name]
  }
  for (const name of Object.keys(environment)) {
    if (/^(?:FOREMAN_CODE|GRAPHQL)_HEAVY_/.test(name)) delete environment[name]
  }
  return environment
}

export function hasNativeTurnStarted(harness, execution, event) {
  const session = execution.nativeSessionId
  if (!session || event.executionId !== execution.id || event.connectionId?.startsWith('history-')) return false
  if (harness === 'codex') return event.type === 'turn.started' && event.payload.threadId === session
  if (harness === 'claude') return event.type === 'claude.text'
    && event.payload.role !== 'user' && Boolean(event.payload.text) && event.payload.nativeSessionId === session
  return false
}

export function localProductionEnvironment(desktopHome, password) {
  const current = join(desktopHome, '.local/lib/graphql-production/current')
  const state = join(desktopHome, '.local/state/graphql-production')
  const data = join(desktopHome, '.local/share/graphql-production')
  return {
    NODE_ENV: 'production',
    FOREMAN_CODE_LOCAL_PRODUCTION: '1',
    HOST: '127.0.0.1',
    PORT: '3041',
    DATABASE_URL: `postgresql://graphql_production:${password}@127.0.0.1:55440/graphql_production`,
    // Existing database units invoke Compose directly with this spelling.
    GRAPHQL_PRODUCTION_DB_PASSWORD: password,
    FOREMAN_CODE_BROWSER_ORIGIN: 'http://127.0.0.1:3041',
    FOREMAN_CODE_WEB_DIST: join(current, 'apps/web/dist'),
    WORKSPACE_STORAGE_ROOT: join(data, 'workspaces'),
    FILE_STORAGE_ROOT: join(data, 'files'),
    HARNESS_WORKSPACE_ROOT: join(state, 'runs'),
    // Native entries use one reviewed launcher; each credential selects its own app.
    FOREMAN_CODE_APP_MCP_DIRECTORY: join(desktopHome, '.local/share/graphql/mcp'),
    LOG_DIR: join(state, 'logs'),
    XDG_CACHE_HOME: join(state, 'cache'),
    LANGGRAPH_CHECKPOINT_SCHEMA: 'langgraph',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  }
}

// Installed dependencies are immutable; contracts build output belongs to each release.
async function apiDependencyKey(source) {
  const hash = createHash('sha256')
  hash.update(`${process.platform}\0${process.arch}\0${process.versions.modules}\0`)
  const inputs = ['pnpm-lock.yaml', 'apps/api/package.json', 'packages/contracts/package.json',
    'pnpm-workspace.yaml', '.npmrc']
  for (const path of inputs) {
    hash.update(`${path}\0`)
    try {
      const bytes = await readFile(join(source, path))
      hash.update(`${bytes.length}\0`).update(bytes)
    } catch (error) {
      if (error.code !== 'ENOENT' || inputs.indexOf(path) < 3) throw error
      hash.update('absent\0')
    }
  }
  return hash.digest('hex').slice(0, 32)
}

async function linkReleaseDependencies(shared, destination, source) {
  const installed = join(shared, 'api/node_modules')
  const modules = join(destination, 'node_modules')
  await mkdir(join(modules, '@foreman-code'), { recursive: true })
  for (const name of await readdir(installed)) {
    if (name === '@foreman-code') continue
    await symlink(join(installed, name), join(modules, name))
  }
  for (const name of await readdir(join(installed, '@foreman-code'))) {
    if (name === 'contracts') continue
    await symlink(join(installed, '@foreman-code', name), join(modules, '@foreman-code', name))
  }
  const contracts = await realpath(join(installed, '@foreman-code/contracts'))
  const releaseContracts = join(modules, '@foreman-code/contracts')
  await cp(contracts, releaseContracts, { recursive: true, verbatimSymlinks: true,
    filter: path => path !== join(contracts, 'node_modules') && path !== join(contracts, 'dist') })
  await copyFile(join(source, 'packages/contracts/package.json'), join(releaseContracts, 'package.json'))
  await cp(join(source, 'packages/contracts/dist'), join(releaseContracts, 'dist'), { recursive: true })
  // pnpm places a workspace package's dependencies beside its scope in the virtual store.
  const nested = join(contracts, 'node_modules')
  const dependencies = existsSync(nested) ? nested : dirname(dirname(contracts))
  await symlink(dependencies, join(releaseContracts, 'node_modules'))
  await symlink(installed, join(modules, '.production-dependencies'))
}

export async function deployProductionApi(run, destination, { dependencies } = {}) {
  if (!dependencies) return deployApiPackage(run, destination)
  await mkdir(dependencies.root, { recursive: true, mode: 0o700 })
  const shared = join(dependencies.root, await apiDependencyKey(dependencies.source))
  const ready = await lstat(join(shared, 'api')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  if (!ready) {
    const staging = await mkdtemp(join(dependencies.root, '.staging-'))
    try {
      await deployApiPackage(run, join(staging, 'api'))
      await rename(staging, shared)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      // Another install finished the same tree first; it is identical.
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
    }
  }
  await mkdir(destination, { recursive: true })
  for (const name of await readdir(join(shared, 'api'))) {
    if (name === 'node_modules' || name === 'dist') continue
    await cp(join(shared, 'api', name), join(destination, name), { recursive: true, verbatimSymlinks: true })
  }
  // The API's own build output always comes from this build.
  await cp(join(dependencies.source, 'apps/api/dist'), join(destination, 'dist'), { recursive: true, verbatimSymlinks: true })
  await linkReleaseDependencies(shared, destination, dependencies.source)
}

/** Removes shared dependency trees that none of `releases` (release directories) links to. */
export async function pruneApiDependencies(root, releases, { removeInBackground = removeDetached } = {}) {
  const used = new Set()
  for (const release of releases) {
    const modules = join(release, 'apps/api/node_modules')
    const info = await lstat(modules).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) continue
    const link = await readlink(info.isSymbolicLink() ? modules : join(modules, '.production-dependencies'))
      .catch(error => {
        // Older releases carry their own node_modules instead of using the shared cache.
        if (error.code === 'ENOENT' && info.isDirectory()) return undefined
        throw error
      })
    if (link) used.add(dirname(dirname(link)))
  }
  let entries
  try { entries = await readdir(root) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const removed = []
  let pruned
  for (const name of entries) {
    if (name.startsWith('.') || used.has(join(root, name))) continue
    pruned ??= await mkdtemp(join(root, '.pruned-'))
    await rename(join(root, name), join(pruned, name))
    removed.push(join(root, name))
  }
  if (pruned) removeInBackground(pruned)
  return removed
}

async function runDependencyCommand(run, args) {
  const timeout = 5 * 60_000
  try {
    return await run('corepack', ['pnpm', ...args], { timeout, killSignal: 'SIGKILL' })
  } catch (cause) {
    // pnpm reports failures such as release-age violations on stdout, so keep the command output on the error.
    throw Object.assign(new Error(`Production dependency command "corepack pnpm ${args.join(' ')}" failed `
      + `(${timeout} ms timeout): ${cause.message}`, { cause }), { stdout: cause.stdout, stderr: cause.stderr })
  }
}

export async function installProductionDependencies(run) {
  await runDependencyCommand(run, ['install', '--frozen-lockfile'])
}

async function deployApiPackage(run, destination) {
  const failures = []
  try {
    // Shared-lockfile deployment keeps resolved versions and their supply-chain checks.
    await runDependencyCommand(run, ['--filter', '@foreman-code/api', 'deploy', '--prod', destination])
    // Freeze mutable workspace files; pnpm already isolates installed dependencies.
    const contracts = await realpath(join(destination, 'node_modules/@foreman-code/contracts'))
    for (const packageDirectory of [destination, contracts]) {
      const temporary = await mkdtemp(join(dirname(packageDirectory), '.production-package-copy-'))
      try {
        const snapshot = join(temporary, 'package')
        const dependencies = join(packageDirectory, 'node_modules')
        const entries = await readdir(packageDirectory)
        await cp(packageDirectory, snapshot, { recursive: true, verbatimSymlinks: true,
          filter: source => source !== dependencies })
        if (entries.includes('node_modules')) await rename(dependencies, join(snapshot, 'node_modules'))
        await rm(packageDirectory, { recursive: true })
        await rename(snapshot, packageDirectory)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  } catch (error) {
    failures.push(error)
  }
  // Subsequent build commands use the complete workspace, including development dependencies.
  try {
    await installProductionDependencies(run)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) {
    throw new AggregateError(failures, 'Production deployment and workspace restoration failed: '
      + failures.map(error => error.message).join('; '))
  }
}

export async function removeUninstalledRelease(release, current) {
  let installed
  try {
    installed = await realpath(current)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (installed === await realpath(release)) return
  await rm(release, { recursive: true, force: true })
}

export async function publish(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(`${path}.temporary-`)
  const temporary = join(directory, 'content')
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function withInstallationLock(path, action, { timeoutMs } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'a', 0o600)
  try {
    // flock and this process share the open file description, so the lock lasts
    // until the parent closes it, including if the parent exits unexpectedly.
    await new Promise((resolve, reject) => {
      const args = ['--exclusive', ...(timeoutMs ? ['--wait', String(timeoutMs / 1000)] : []), '3']
      const child = spawn('/usr/bin/flock', args, {
        stdio: ['ignore', 'inherit', 'inherit', handle.fd],
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('An installation is still in progress. Try again later.')))
    })
    return await action()
  } finally {
    await handle.close()
  }
}

function environmentValue(content, start) {
  let value = ''
  let mode = 'leading'
  let trailingWhitespace
  let offset = start
  for (; offset < content.length; offset += 1) {
    const character = content[offset]
    const quoted = mode === 'single' || mode === 'double'
    if (quoted) {
      const quote = mode === 'single' ? "'" : '"'
      if (character === quote) {
        mode = 'leading'
      } else if (mode === 'double' && character === '\\') {
        const escaped = content[++offset]
        if (escaped !== undefined && escaped !== '\n') {
          value += '"\\`$'.includes(escaped) ? escaped : `\\${escaped}`
        }
      } else {
        value += character
      }
      continue
    }
    if (character === '\n') break
    if (mode === 'leading') {
      if (' \t\r'.includes(character)) continue
      if (character === "'" || character === '"') {
        mode = character === "'" ? 'single' : 'double'
        continue
      }
      mode = 'unquoted'
    }
    if (character === '\\') {
      trailingWhitespace = undefined
      const escaped = content[++offset]
      if (escaped !== undefined && escaped !== '\n') value += escaped
    } else {
      if (' \t\r'.includes(character)) trailingWhitespace ??= value.length
      else trailingWhitespace = undefined
      value += character
    }
  }
  if (mode === 'unquoted' && trailingWhitespace !== undefined) value = value.slice(0, trailingWhitespace)
  return { value, end: offset }
}

function parseEnvironment(content) {
  const assignments = /(?:^|\n)[ \t\r]*([A-Za-z_][A-Za-z0-9_]*)[ \t\r]*=/g
  const entries = []
  for (let match = assignments.exec(content); match; match = assignments.exec(content)) {
    const parsed = environmentValue(content, assignments.lastIndex)
    entries.push([match[1], parsed.value])
    assignments.lastIndex = parsed.end
  }
  return Object.fromEntries(entries)
}

export async function readEnvironment(path) {
  try {
    // production.env is an EnvironmentFile, whose quoting differs from dotenv.
    return parseEnvironment(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function preserveOperatorConfiguration(path, previous, owned, validate) {
  const canonicalName = key => key.replace(/^GRAPHQL_/, 'FOREMAN_CODE_')
  const keepSetting = ([key]) => canonicalName(key) !== 'FOREMAN_CODE_DEV_BROWSER_ACCESS'
  const managed = new Set(Object.keys(owned).map(canonicalName))
  const previousSettings = Object.fromEntries(Object.entries(previous ?? {}).filter(keepSetting))
  resolveProductEnvironment(previousSettings)
  let configuration
  try {
    configuration = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    configuration = Object.fromEntries(Object.entries(previousSettings).filter(([key]) => !managed.has(canonicalName(key))))
  }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Operator configuration must be an object of environment settings.')
  }
  configuration = Object.fromEntries(Object.entries(configuration).filter(keepSetting))
  for (const [key, value] of Object.entries(configuration)) {
    if (managed.has(canonicalName(key))) {
      throw new Error(`${key} is managed by the installer; remove it from operator.json.`)
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`Invalid operator setting: ${key}.`)
    }
  }
  const environment = { ...configuration, ...owned }
  resolveProductEnvironment(environment)
  await validate(environment)
  await publish(path, JSON.stringify(configuration, null, 2) + '\n')
  return environment
}

export function renderEnvironment(environment) {
  return Object.entries(environment).map(([key, value]) => {
    const quoted = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    return `${key}="${quoted}"`
  }).join('\n') + '\n'
}

/**
 * An API restart closes every native agent process it owns, and their Runs fail without replay.
 * Install therefore waits until no Run is queued, running or waiting, unless the operator accepts the interruption.
 */
export async function waitForIdleRuns({ query, timeoutMs, pollMs = 15_000, interrupt = false, log = console.log, sleep = delay }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Run idle-wait timeout must be finite and nonnegative.')
  if (interrupt) return
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const active = (await query("select id from runs where execution_state in ('queued','running','waiting') order by id")).rows.map(row => row.id)
    if (!active.length) return
    if (Date.now() >= deadline) {
      throw new Error(`${active.length} Run(s) still active (${active.join(', ')}). Restarting the API would interrupt them. `
        + 'Let them finish, stop them, or rerun with FOREMAN_INSTALL_INTERRUPT_RUNS=1.')
    }
    log(`Waiting for ${active.length} active Run(s) to finish before restarting the API: ${active.join(', ')}`)
    await sleep(pollMs)
  }
}

export async function readActiveRuns(release, databaseUrl, wait) {
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 })
  try {
    return await withRunStartMaintenance(pool, wait)
  } finally {
    await pool.end()
  }
}

export async function withRunStartMaintenance(pool, action, { timeoutMs = 30_000, pollMs = 100 } = {}) {
  const client = await pool.connect()
  const closed = new Promise(resolve => client.once('end', resolve))
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const result = await client.query(
        'select pg_try_advisory_lock(hashtext($1), hashtext(current_schema())) as locked',
        [productionMaintenanceKey],
      )
      if (result.rows[0]?.locked === true) break
      if (Date.now() >= deadline) throw new Error('Run publication is still in progress. Retry installation later.')
      await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    }
    return await action(text => client.query(text))
  } finally {
    // Destroy the session to release the maintenance lock before installation completes.
    client.release(true)
    await closed
  }
}

/** Each install stages a full release (~1 GB). Keep the running one and the previous one for rollback; remove the rest. */
// Deleting a release's dependency tree takes ~20 s; installs move it aside and let a detached process delete it.
/**
 * Starts work that must outlive this install. A detached child still dies with the install's systemd unit (the
 * unit's control group is killed when it ends), so the work gets its own transient user unit when systemd-run exists.
 */
export function startBackground(name, command, args, { logFile, systemdRun = existsSync('/usr/bin/systemd-run')
  ? '/usr/bin/systemd-run' : null, spawnProcess = spawn } = {}) {
  if (!systemdRun) {
    spawnProcess(command, args, { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawnProcess(systemdRun, ['--user', '--collect', '--quiet', `--unit=${name}-${randomBytes(4).toString('hex')}`,
    `--setenv=PATH=${process.env.PATH}`,
    ...(logFile ? [`--property=StandardOutput=append:${logFile}`, `--property=StandardError=append:${logFile}`] : []),
    command, ...args], { detached: true, stdio: 'ignore' }).unref()
}

function removeDetached(directory) {
  startBackground('foreman-remove-release', 'rm', ['-rf', '--', directory])
}

export async function pruneReleases(releasesDirectory, keep,
  { current = join(dirname(releasesDirectory), 'current'), removeInBackground = removeDetached } = {}) {
  const directory = await realpath(releasesDirectory)
  const retained = keep.filter(Boolean)
  try {
    // A missing selection is valid before first activation; a dangling link is not.
    await lstat(current)
    retained.push(current)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const kept = new Set(await Promise.all(retained.map(path => realpath(path))))
  // Retry detached removals left behind by an interrupted installer or remover.
  const parent = dirname(directory)
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.pruned-releases-')) continue
    const abandoned = join(parent, entry.name)
    const inUse = [...kept].some(path => path === abandoned || path.startsWith(`${abandoned}/`))
    if (!inUse) await removeInBackground(abandoned)
  }
  const removed = []
  const candidates = []
  for (const name of await readdir(directory)) {
    if (!name.startsWith('release-')) continue
    const path = join(releasesDirectory, name)
    candidates.push({ path, identity: await realpath(path) })
  }
  let pruned
  for (const { path, identity } of candidates) {
    if (kept.has(identity)) continue
    // A rename within the installation is atomic, so the releases directory never shows a half-deleted release.
    pruned ??= await mkdtemp(join(dirname(directory), '.pruned-releases-'))
    await rename(path, join(pruned, path.slice(path.lastIndexOf('/') + 1)))
    removed.push(path)
  }
  if (pruned) removeInBackground(pruned)
  return removed
}

export async function readProductionIdentity(release, databaseUrl) {
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const { readRuntimeIdentity } = await import(pathToFileURL(join(release, 'apps/api/dist/infrastructure/runtimeIdentity.js')))
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
    query_timeout: 5000 })
  try {
    return await readRuntimeIdentity(pool, release, databaseUrl)
  } finally {
    await pool.end()
  }
}

export async function waitForProductionReady(options) {
  try {
    const controller = new AbortController()
    const start = Promise.resolve().then(() => options.start?.()).catch(error => {
      controller.abort(error)
      throw error
    })
    // systemctl's start job also checks health; polling concurrently avoids a second serialized readiness wait.
    const results = await Promise.allSettled([start, pollProductionReady({ ...options, signal: controller.signal })])
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
    await options.smoke?.()
  } catch (error) {
    try { await options.rollback?.(error) }
    catch (failure) { throw new Error(`${error.message}\nRollback failed: ${failure.message}`, { cause: error }) }
    throw error
  }
}

async function pollProductionReady({ origin, expected, timeoutMs = 90_000, signal }) {
  const deadline = Date.now() + timeoutMs
  let failure = 'API has not responded.'
  const identityMatches = async () => {
    const response = await fetch(`${origin}/health/identity`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })
    const actual = await response.json()
    return response.ok && ['installationId', 'databaseId', 'checkoutId'].every(key => actual[key] === expected[key])
  }
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    try {
      if (!await identityMatches()) {
        throw new Error('Port 3041 is serving a different database installation or release.')
      }
      const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })
      const health = await response.json()
      if (response.ok && health.service === 'graphql-api' && health.checks?.database === 'ok'
        && health.checks?.checkpoints === 'ok') {
        const web = await fetch(`${origin}/workspaces`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })
        if (web.ok && (await web.text()).includes('/assets/') && await identityMatches()) return
        failure = 'The compiled dashboard is unavailable.'
      } else failure = `Readiness returned HTTP ${response.status}.`
    } catch (error) {
      failure = error.message
    }
    await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal })
  }
  throw new Error(`${failure} Inspect journalctl --user -u graphql-operator-api.service.`)
}

export async function copyVerificationRuntime(source, release) {
  const paths = ['scripts/ci-watchdog.mjs', 'scripts/ci-progress-reporter.mjs',
    'scripts/ci-test-results.mjs', 'scripts/dense-resources.mjs',
    'scripts/verification-runner.mjs', 'scripts/verification-reports.mjs',
    'scripts/integration-process.mjs', 'scripts/integration-capabilities.mjs',
    'apps/worker/src/diagnostics.mjs', 'packages/contracts/src/verificationEnvironment.mjs',
    'packages/contracts/src/integrationScheduling.mjs']
  for (const path of paths) {
    const destination = join(release, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(source, path), destination)
  }
}
