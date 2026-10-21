import { requirements } from '../packages/contracts/src/integrationScheduling.mjs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, rmdirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { hostFacts } from '../apps/worker/src/diagnostics.mjs'
import { readVerificationEnvironment } from '../packages/contracts/src/verificationEnvironment.mjs'

const nativeUnitFiles = new Set([
  'apps/api/test/native-guardian-outcome.test.ts',
  'apps/api/test/native-launch-abandonment.test.ts',
  'apps/api/test/native-process-ownership.test.ts',
  'apps/api/test/native-response-recovery.test.ts',
  'apps/api/test/codex-idle-recovery.test.ts',
  'apps/api/test/codex-pending-turn-restart.test.ts',
  'apps/api/test/native-qualification-command-lifecycle.test.ts',
  'apps/api/test/codex-protocol.test.ts',
])

export function partitionUnitCapabilities(files, environment) {
  const requirements = new Map([...nativeUnitFiles].map(file => [file, ['nativeCgroupDelegation']]))
  return partitionCapabilities(files, environment, requirements)
}

/** Matches the installer persistence checks and the fixture's approved packaging targets. */
export function supportsInstalledWorkerHost(facts, targets) {
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) return false
  if (facts.os !== 'ubuntu' || facts.arch !== 'x64') return false
  const fields = ['os', 'osRelease', 'arch', 'libc', 'node']
  return targets.some(target => fields.every(field => target[field] === facts[field]))
}

async function installedWorkerHost(environment) {
  const home = homedir()
  const facts = await hostFacts(home, [join(home, '.cache', 'graphql-disposable-tests')])
  const root = fileURLToPath(new URL('..', import.meta.url))
  const names = [
    'test-hosts/ubuntu-24.04-x64-target.json', 'ubuntu-26.04-x64-target.json',
    'test-hosts/ubuntu-24.04-x64-node-22.23.2-target.json', 'test-hosts/ubuntu-26.04-x64-node-22.23.2-target.json',
  ]
  // Artifact builds use the approved Git snapshot, not uncommitted target edits.
  const targets = names.map(name => {
    const result = spawnSync('git', ['show', `HEAD:apps/worker/artifacts/${name}`], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    })
    if (result.status !== 0) throw new Error(`Could not read approved Worker packaging target: ${name}`)
    return JSON.parse(result.stdout)
  })
  return supportsInstalledWorkerHost(facts, targets)
}

function nativeCgroupDelegation() {
  let directory
  try {
    const entry = /^0::(\/[^\n]*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1]
    if (!entry || entry.split('/').includes('..')) return false
    const parent = join('/sys/fs/cgroup', entry)
    if (statfsSync(parent).type !== 0x63677270) return false
    const child = join(parent, `foreman-verification-probe-${randomUUID()}`)
    mkdirSync(child)
    directory = child
    accessSync(join(child, 'cgroup.kill'), constants.W_OK)
    accessSync(join(child, 'cgroup.procs'), constants.W_OK)
    return true
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EROFS'].includes(error.code)) return false
    throw error
  } finally {
    if (directory) rmdirSync(directory)
  }
}

/** Host probes observe existing delegation/services; they never start or reconfigure them. */
export async function integrationEnvironmentCapabilities(environment = process.env) {
  const declared = readVerificationEnvironment(environment)
  if (declared) return declared
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
  })
  const compose = docker.status === 0 && spawnSync('docker', ['compose', 'version'], {
    env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
  }).status === 0
  return { schemaVersion: 1, runtime: 'host', capabilities: {
    nativeCgroupDelegation: nativeCgroupDelegation(), dockerCompose: compose, testDatabaseStartup: compose,
    installedWorkerHost: await installedWorkerHost(environment),
  } }
}

/** Unsupported files remain required, with a reason in the report; they are never passing or skipped tests. */
export function partitionIntegrationCapabilities(files, environment) {
  return partitionCapabilities(files, environment, requirements)
}

function partitionCapabilities(files, environment, requirements) {
  const runnable = []
  const unavailable = []
  for (const file of files) {
    const missing = (requirements.get(file) ?? []).filter(name => environment.capabilities[name] !== true)
    if (missing.length) unavailable.push({ file, code: null, complete: false,
      requiredCapabilities: missing, reason: `Runtime lacks required capabilities: ${missing.join(', ')}` })
    else runnable.push(file)
  }
  return { runnable, unavailable }
}
