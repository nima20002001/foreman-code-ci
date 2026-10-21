import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runProductionCiSmoke } from './install-ci-smoke.mjs'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { renderUserService } from '../apps/worker/src/service.mjs'
import { workerPath } from '../apps/worker/src/harnessPath.mjs'
import { buildWorkerReleaseArtifacts, workerPublicationServiceTemplate } from './worker-release-artifacts.mjs'
import {
  copyVerificationRuntime, deployProductionApi, desktopLaunchEnvironment, localProductionEnvironment, preserveOperatorConfiguration, publish, readEnvironment,
  pruneApiDependencies, pruneReleases, removeUninstalledRelease, readActiveRuns, readProductionIdentity, waitForIdleRuns, renderEnvironment, waitForProductionReady, withInstallationLock,
  shouldOpenDashboardAfterInstall,
  productionIntegrationPaths, publishDesktopIntegration, enableProductionServices, apiServiceTemplate,
  launchProduction, launchBrowser, parseRunWaitMinutes, readReleaseSelection,
  needsStartupConfiguration, recordStartupConfiguration, withProductionSourceSnapshot, buildProductionSource,
  readPendingMigrations, runReleaseCutover, recoverReleaseCutover,
  measureProductionStep, installProductionDependencies,
  stageProductionBrowserRuntime, productionBrowserRuntimeLifecycle,
} from './local-production-runtime.mjs'

const source = fileURLToPath(new URL('../', import.meta.url))
const home = homedir()
const app = join(home, '.local/lib/graphql-production')
const state = join(home, '.local/state/graphql-production')
const data = join(home, '.local/share/graphql-production')
const config = join(home, '.config/graphql-production')
const envFile = join(config, 'production.env')
const deploymentFile = join(config, 'deployment.json')
const startupFile = join(config, 'installation.json')
const current = join(app, 'current')
const origin = 'http://127.0.0.1:3041'
const capture = promisify(execFile)
const units = {
  database: 'graphql-production-db.service',
  api: 'graphql-operator-api.service',
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: source, stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ?? code}).`))
    })
  })
}

async function configureEnvironment(buildSource) {
  for (const directory of [config, state, data, app, join(data, 'files'), join(data, 'workspaces'),
    join(state, 'runs'), join(state, 'logs'), join(state, 'cache')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  let password
  const previous = await readEnvironment(envFile)
  if (previous) {
    password = readProductEnvironment(previous, 'PRODUCTION_DB_PASSWORD')
    if (!password || !/^[a-f0-9]{64}$/.test(password)) {
      throw new Error('The production database password is missing or invalid. Restore production.env; do not reset the database.')
    }
  } else {
    const { stdout } = await capture('/usr/bin/docker', ['volume', 'ls', '--format', '{{.Name}}'])
    if (stdout.split('\n').includes('graphql-production-postgres')) {
      throw new Error('Production storage already exists. Restore production.env before updating; its password must stay stable.')
    }
    password = randomBytes(32).toString('hex')
  }
  const owned = localProductionEnvironment(home, password)
  const { loadConfig } = await import(pathToFileURL(join(buildSource, 'apps/api/dist/config.js')))
  const environment = await preserveOperatorConfiguration(join(config, 'operator.json'), previous, owned, loadConfig)
  await publish(envFile, renderEnvironment(environment))
  return environment
}

async function stageRelease({ source: buildSource, commit }, runBuild, previousRelease) {
  const releases = join(app, 'releases')
  await mkdir(releases, { recursive: true, mode: 0o700 })
  const release = await mkdtemp(join(releases, 'release-'))
  try {
    await mkdir(join(release, 'apps'), { recursive: true })
    await deployProductionApi(runBuild, join(release, 'apps/api'),
      { dependencies: { root: join(app, 'api-dependencies'), source: buildSource } })
    await cp(join(buildSource, 'apps/web/dist'), join(release, 'apps/web/dist'), { recursive: true })
    await mkdir(join(release, 'scripts'), { recursive: true })
    for (const name of ['local-production.mjs', 'local-production-runtime.mjs', 'graphql-mcp.mjs',
      'worker-release-artifacts.mjs', 'worker-artifact-files.mjs', 'install-ci-smoke.mjs']) {
      await copyFile(join(buildSource, 'scripts', name), join(release, 'scripts', name))
    }
    await copyVerificationRuntime(buildSource, release)
    const contractsSource = join(release, 'packages/contracts/src')
    await mkdir(contractsSource, { recursive: true })
    for (const name of ['productEnvironment.mjs', 'productionMaintenance.mjs']) {
      await copyFile(join(buildSource, 'packages/contracts/src', name), join(contractsSource, name))
    }
    await mkdir(join(release, 'apps/worker/src'), { recursive: true })
    for (const name of ['service.mjs', 'diagnostics.mjs', 'harnessPath.mjs', 'browserRuntimeInstall.mjs']) {
      await copyFile(join(buildSource, 'apps/worker/src', name), join(release, 'apps/worker/src', name))
    }
    const { stdout: remote } = await capture('git', ['remote', 'get-url', 'origin'], { cwd: buildSource })
    const repository = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(remote)?.[1]
    if (!repository) throw new Error('Production CI smoke requires a GitHub origin repository.')
    await publish(join(release, 'ci-smoke.json'), JSON.stringify({ commit, repository }))
    await copyFile(process.execPath, join(release, 'node'))
    await chmod(join(release, 'node'), 0o700)
    // Devices wait for the background publisher to verify GitHub assets before selecting this Worker target.
    await measureProductionStep('Worker artifacts', () => buildWorkerReleaseArtifacts({ repository: buildSource, expectedCommit: commit,
      directory: join(release, 'worker-artifacts'), productManifestPath: join(release, 'package.json'),
      previousDirectory: previousRelease ? join(previousRelease, 'worker-artifacts') : undefined, run: runBuild }))
    await measureProductionStep('Managed browser runtime', () => stageProductionBrowserRuntime({ release, appRoot: app }))
    const provenance = { api: commit, web: commit, contracts: commit, worker: commit }
    await publish(join(release, 'source.json'), JSON.stringify(provenance) + '\n')
    return release
  } catch (error) {
    await removeUninstalledRelease(release, current)
    throw error
  }
}

function service(template) {
  return renderUserService(template, {
    node: join(current, 'node'), app, state, home,
    path: `${current}:${workerPath(home, process.execPath)}`,
  })
}

async function installServices() {
  const directory = productionIntegrationPaths(home, process.env).units
  await publish(join(directory, units.database), service(`[Unit]
Description=Foreman Code production PostgreSQL
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=@HOME@/.config/graphql-production/production.env
ExecStartPre=/usr/bin/timeout 60 /bin/sh -c 'until /usr/bin/docker info >/dev/null 2>&1; do /usr/bin/sleep 2; done'
ExecStart=/usr/bin/docker compose --project-name graphql-local-production --file @APP@/compose.production.yaml up --detach --wait --wait-timeout 90 postgres
ExecStop=/usr/bin/docker compose --project-name graphql-local-production --file @APP@/compose.production.yaml stop --timeout 30 postgres
Restart=on-failure
RestartSec=5
TimeoutStartSec=160
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=default.target
`))
  await publish(join(directory, units.api), service(apiServiceTemplate(units.database)))
  await publish(join(directory, 'foreman-worker-publish.service'), service(workerPublicationServiceTemplate()))
}

async function installDesktop(firstInstall, buildSource) {
  const paths = productionIntegrationPaths(home, process.env)
  const icon = paths.icon
  const launcher = join(app, 'graphql')
  await publish(launcher, `#!/bin/sh
exec '${current}/node' '${current}/scripts/local-production.mjs' launch
`, 0o700)
  await publishDesktopIntegration(paths, { firstInstall,
    icon: await readFile(join(buildSource, 'apps/web/public/graphql.svg')),
    desktop: `[Desktop Entry]
Type=Application
Name=Foreman Code
Comment=Local agent workspace
Exec=${launcher}
Icon=${icon}
StartupWMClass=graphql-production
Terminal=true
Categories=Development;
`, autostart: `[Desktop Entry]
Type=Application
Name=Foreman Code
Comment=Start the local dashboard after desktop login
Exec=${launcher}
Icon=${icon}
Terminal=true
X-GNOME-Autostart-enabled=true
` })
}

async function waitForReady({ timeoutMs = 90_000, selectedRelease, ...checks } = {}) {
  const environment = await readEnvironment(envFile)
  if (!environment) throw new Error('Production configuration is missing.')
  const release = selectedRelease ?? await realpath(current)
  const expected = await readProductionIdentity(release, environment.DATABASE_URL)
  await waitForProductionReady({ origin, expected, timeoutMs, ...checks })
}

async function runAuthenticatedCiSmoke(release, environment) {
  if (process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE === '1') {
    await runProductionCiSmoke({ origin, release })
    return
  }
  const api = join(release, 'apps/api/dist')
  const { loadConfig } = await import(pathToFileURL(join(api, 'config.js')))
  const { createDatabase } = await import(pathToFileURL(join(api, 'infrastructure/database.js')))
  const { withInstallSmokeCredential } = await import(pathToFileURL(join(api, 'cli/installSmokeCredential.js')))
  const database = createDatabase(loadConfig({ ...process.env, ...environment }).database)
  try {
    await withInstallSmokeCredential(database.pool, token => runProductionCiSmoke({ origin, release, token }))
  } finally {
    await database.close()
  }
}

async function activateRelease(release) {
  if (!release) {
    await rm(current, { force: true })
    return
  }
  const pending = join(app, `current.${randomBytes(8).toString('hex')}`)
  try {
    await symlink(release, pending)
    await rename(pending, current)
  } finally {
    await rm(pending, { force: true })
  }
}

function cutoverSteps(environment, { firstInstall = false, drainTimeoutMs } = {}) {
  const browserRuntime = productionBrowserRuntimeLifecycle({ appRoot: app, stateDirectory: state, drainTimeoutMs })
  return {
    browserRuntime,
    pendingMigrations: release => readPendingMigrations(release, environment.DATABASE_URL),
    stop: () => run('/usr/bin/systemctl', ['--user', 'stop', units.api]),
    migrate: release => run(join(release, 'node'), ['dist/cli/migrate.js'], {
      cwd: join(release, 'apps/api'), env: { ...process.env, ...environment },
    }),
    upgradeLauncher: async release => {
      const upgradeModule = join(release, 'apps/api/dist/modules/harnesses/productionMcpUpgrade.js')
      const { upgradeProductionMcpLauncher } = await import(pathToFileURL(upgradeModule))
      await upgradeProductionMcpLauncher(home)
    },
    activate: activateRelease,
    enable: () => enableProductionServices(run, [units.database, units.api], { firstInstall }),
    start: () => run('/usr/bin/systemctl', ['--user', 'start', units.api]),
    ready: async release => { await waitForReady({ selectedRelease: release }); await browserRuntime.verify(release) },
    checkReady: (release, { start, rollback }) => waitForReady({ selectedRelease: release,
      start, smoke: () => runAuthenticatedCiSmoke(release, environment), rollback }),
  }
}

async function install(timeoutMs) {
  // The worker service renderer also validates the installation paths before any mutation.
  service('@NODE@ @APP@ @STATE@ @HOME@ @PATH@')
  await access('/usr/bin/docker', constants.X_OK)
  await access('/usr/bin/google-chrome', constants.X_OK)
  await access('/usr/bin/ss', constants.X_OK)
  await recoverReleaseCutover({ stateFile: deploymentFile, steps: cutoverSteps(await readEnvironment(envFile)) })
  const previousRelease = await readReleaseSelection(current)
  const firstInstall = await needsStartupConfiguration(startupFile, { previousRelease })
  await withProductionSourceSnapshot(source, join(state, 'builds'), async snapshot => {
    const runBuild = (command, args, options = {}) => run(command, args, { cwd: snapshot.source, ...options })
    await installProductionDependencies(runBuild)
    let release
    let environment
    try {
      await buildProductionSource(runBuild, { stage: async () => {
        release = await stageRelease(snapshot, runBuild, previousRelease)
      } })
      environment = await configureEnvironment(snapshot.source)
    } catch (error) {
      if (release) await removeUninstalledRelease(release, current)
      throw error
    }
    await finishInstallation({ release, previousRelease, firstInstall, environment, snapshot, timeoutMs })
  })
}

async function finishInstallation({ release, previousRelease, firstInstall, environment, snapshot, timeoutMs }) {
  let cutoverBegan = false
  try {
    await copyFile(join(snapshot.source, 'compose.production.yaml'), join(app, 'compose.production.yaml'))
    await run('/usr/bin/docker', ['volume', 'create', '--label', 'io.graphql.environment=production', 'graphql-production-postgres'])
    await installServices()
    await installDesktop(firstInstall, snapshot.source)
    await run('/usr/bin/systemctl', ['--user', 'daemon-reload'])
    await run('/usr/bin/systemctl', ['--user', 'start', units.database])
    const cutover = async () => {
      cutoverBegan = true
      await runReleaseCutover({ release, previousRelease, stateFile: deploymentFile,
        steps: cutoverSteps(environment, { firstInstall, drainTimeoutMs: timeoutMs }) })
    }
    if (previousRelease) {
      await readActiveRuns(release, environment.DATABASE_URL, async query => {
        await waitForIdleRuns({ query, timeoutMs, interrupt: process.env.FOREMAN_INSTALL_INTERRUPT_RUNS === '1' })
        await cutover()
      })
    } else await cutover()
    await recordStartupConfiguration(startupFile)
    try { await productionBrowserRuntimeLifecycle({ appRoot: app, stateDirectory: state }).prune() }
    catch (error) { console.warn(`Browser runtime cleanup will retry on the next install: ${error.message}`) }
    const pruned = await pruneReleases(join(app, 'releases'), [release, previousRelease])
    if (pruned.length) console.log(`Removed ${pruned.length} old release(s); kept the current and previous release.`)
    const kept = (await readdir(join(app, 'releases'))).filter(name => name.startsWith('release-')).map(name => join(app, 'releases', name))
    await pruneApiDependencies(join(app, 'api-dependencies'), kept)
    console.log(`Foreman Code backend installed: ${origin}/workspaces`)
    if (shouldOpenDashboardAfterInstall({ previousRelease, stdin: process.stdin, stdout: process.stdout })) {
      await handoffDashboard()
    } else {
      console.log('Open Foreman Code from the desktop launcher when ready.')
    }
    console.log(`API logs: ${state}/logs (and journalctl --user -u ${units.api})`)
  } finally {
    if (!cutoverBegan) await removeUninstalledRelease(release, current)
  }
}

async function handoffDashboard() {
  await launchBrowser('/usr/bin/google-chrome', [`--app=${origin}/workspaces`, '--class=graphql-production'], {
    environment: desktopLaunchEnvironment(process.env),
  })
  console.log('Dashboard handed to Chrome.')
}

async function launchDesktop() {
  console.log('Starting Foreman Code; waiting for the local backend…')
  await launchProduction({
    lockPath: join(config, 'install.lock'),
    start: () => capture('/usr/bin/systemctl', ['--user', 'start', '--no-block', units.api], { timeout: 5000 }),
    ready: timeoutMs => waitForReady({ timeoutMs }),
    openDashboard: handoffDashboard,
  })
}

const command = process.argv[2]
try {
  if (command === 'install') {
    productionIntegrationPaths(home, process.env)
    const timeoutMs = parseRunWaitMinutes(process.env.FOREMAN_INSTALL_RUN_WAIT_MINUTES)
    await withInstallationLock(join(config, 'install.lock'), () => install(timeoutMs))
  }
  else if (command === 'health') await waitForReady()
  else if (command === 'open' || command === 'launch') await launchDesktop()
  else throw new Error('Usage: node scripts/local-production.mjs install|health|open|launch')
} catch (error) {
  console.error(`Local production setup failed: ${error.message}`)
  if (command === 'open' || command === 'launch') {
    try {
      await capture('/usr/bin/notify-send', ['Foreman Code could not open',
        'Open a terminal and run the Foreman Code launcher for details. Check journalctl --user -u graphql-operator-api.service.'],
      { timeout: 5000 })
    } catch {
      console.error('Desktop notification unavailable; the launch error is shown in this terminal.')
    }
  }
  process.exitCode = 1
}
