import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { NativeProcessRegistry, readDetachedNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { readUntil } from './helpers/observableCondition.js'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const owner = 'execution:service-restart'

it('keeps the registered native lifetime through a systemd API restart and still closes it explicitly', async () => {
  const directory = await privateFixtureDirectory('native-service-restart-')
  const unit = `foreman-restart-${randomUUID()}.service`
  const databaseUnit = `foreman-restart-db-${randomUUID()}.service`
  const unitPath = join(directory, unit)
  const app = join(directory, 'app')
  const current = join(app, 'current')
  const registryRoot = join(directory, 'runtime/native-process-registry')
  const registry = new NativeProcessRegistry(registryRoot)
  const scope = registry.scope(owner)
  const runtimeModule = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const serviceModule = new URL('../../worker/src/service.mjs', import.meta.url).href
  const registryModule = new URL('../src/modules/harnesses/recovery/processRegistry.ts', import.meta.url).href
  const { apiServiceTemplate } = await import(runtimeModule)
  const { renderUserService } = await import(serviceModule)
  const hostRuntime = `/run/user/${process.getuid!()}`
  // The isolated fixture runtime has no systemd bus; only these UUID-named units use the host manager.
  const systemctl = (...args: string[]) => execute('systemctl', ['--user', ...args], {
    timeout: 30_000,
    env: { ...process.env, XDG_RUNTIME_DIR: hostRuntime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${hostRuntime}/bus` },
  })
  let linked = false, cleaned: boolean | undefined
  const readyFile = join(directory, 'main-ready.json')
  const completedFile = join(directory, 'native-completed.json')
  const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as {
    mainPid: number; nativePid: number; launchId: string
  }
  const waitForCompletion = () => readUntil(async () => {
    try { return await readJson(completedFile) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }, value => value !== undefined, { timeoutMs: 10_000, description: 'original native completion' })

  try {
    await mkdir(join(current, 'apps/api/dist'), { recursive: true })
    await mkdir(join(current, 'scripts'), { recursive: true })
    await mkdir(join(directory, '.config/graphql-production'), { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(directory, '.config/graphql-production/production.env'),
      `NODE_OPTIONS=--import=${require.resolve('tsx')}\n`)
    await writeFile(join(directory, 'native.cjs'), `
const fs = require('node:fs')
const directory = ${JSON.stringify(directory)}
console.log('ready')
const completion = setInterval(() => {
  if (!fs.existsSync(directory + '/release')) return
  fs.writeFileSync(directory + '/completed.pending', JSON.stringify({ nativePid: process.pid }))
  fs.renameSync(directory + '/completed.pending', directory + '/native-completed.json')
  clearInterval(completion)
}, 25)
setInterval(() => {}, 1000)
`)
    await writeFile(join(current, 'apps/api/dist/server.js'), `
import { once } from 'node:events'
import { existsSync, writeFileSync, renameSync } from 'node:fs'
import { NativeProcessRegistry, spawnNativeProcess, readDetachedNativeProcess, detachRecoveredChild }
  from ${JSON.stringify(registryModule)}
const directory = ${JSON.stringify(directory)}
const registry = new NativeProcessRegistry(${JSON.stringify(registryRoot)})
const scope = registry.scope(${JSON.stringify(owner)})
let child
let native = readDetachedNativeProcess(scope)
if (!native) {
  if (existsSync(directory + '/started')) throw new Error('Original native lifetime did not survive.')
  Object.assign(scope, await registry.reserveLaunch(scope.owner))
  child = spawnNativeProcess(process.execPath, [directory + '/native.cjs'], {
    cwd: directory, env: {}, recovery: scope, restartDetachable: true,
  })
  child.stderr.pipe(process.stderr)
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('Native launch failed.') }),
  ])
  native = registry.snapshot().launches.find(launch => launch.owner === scope.owner)
  writeFileSync(directory + '/started', '')
}
if (!native?.provider) throw new Error('Native provider identity is missing.')
writeFileSync(directory + '/main-ready.pending', JSON.stringify({
  mainPid: process.pid, nativePid: native.provider.pid, launchId: native.launchId,
}))
renameSync(directory + '/main-ready.pending', directory + '/main-ready.json')
const keepAlive = setInterval(() => {}, 1000)
process.once('SIGTERM', async () => {
  try {
    if (child) await detachRecoveredChild(child)
    clearInterval(keepAlive)
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
`)
    await writeFile(join(current, 'scripts/local-production.mjs'), `
import { existsSync } from 'node:fs'
const deadline = Date.now() + 10000
const ready = setInterval(() => {
  if (existsSync(${JSON.stringify(readyFile)})) { clearInterval(ready); process.exit(0) }
  if (Date.now() > deadline) process.exit(1)
}, 25)
`)
    await writeFile(join(directory, databaseUnit), '[Service]\nType=oneshot\nExecStart=/usr/bin/true\nRemainAfterExit=yes\n')
    // This fixture owns the API lifetime, not the installation's Worker publisher.
    const template = apiServiceTemplate(databaseUnit)
      .replace(/^ExecStartPost=.*foreman-worker-publish\.service\n/m, '')
    await writeFile(unitPath, renderUserService(template, {
      node: process.execPath, app, state: directory, home: directory, path: '/usr/bin:/bin',
    }))
    await systemctl('--runtime', 'link', unitPath, join(directory, databaseUnit))
    linked = true
    await systemctl('daemon-reload')
    await systemctl('start', unit)
    const original = await readJson(readyFile)
    const before = registry.snapshot().launches.find(launch => launch.launchId === original.launchId)!
    expect(before.lifecycle).toBe('active')
    expect(before.boundary?.kind).toBe('cgroup-v2')

    await rm(readyFile)
    await systemctl('restart', unit)
    const restarted = await readJson(readyFile)
    expect(restarted.mainPid).not.toBe(original.mainPid)
    expect(restarted.nativePid).toBe(original.nativePid)
    expect(restarted.launchId).toBe(original.launchId)
    expect(readDetachedNativeProcess(scope)).toMatchObject({
      launchId: before.launchId, guardian: before.guardian, provider: before.provider, boundary: before.boundary,
    })
    await writeFile(join(directory, 'release'), '')
    expect((await waitForCompletion())!.nativePid).toBe(original.nativePid)
    expect(await registry.closeOwner(owner)).toBe(true)
    expect(() => process.kill(original.nativePid, 0)).toThrow()
  } finally {
    try {
      if (linked) await systemctl('stop', unit, databaseUnit)
    } finally {
      try {
        cleaned = await registry.closeOwner(owner)
      } finally {
        if (linked) {
          await systemctl('--runtime', 'disable', unit, databaseUnit)
          await systemctl('daemon-reload')
        }
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
  if (cleaned !== true) throw new Error('Native fixture cleanup remains unconfirmed.')
}, 90_000)
