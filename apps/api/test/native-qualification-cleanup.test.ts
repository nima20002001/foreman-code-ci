import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { calls, errorCode, fixture } from './fixtures/codex-test-helpers.js'

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, mkdirSync: vi.fn(fs.mkdirSync), renameSync: vi.fn(fs.renameSync), fsyncSync: vi.fn(fs.fsyncSync) }
})
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')

afterEach(() => {
  vi.mocked(fs.mkdirSync).mockImplementation(realFs.mkdirSync)
  vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync)
  vi.mocked(fs.fsyncSync).mockImplementation(realFs.fsyncSync)
})

function factoriesFor(registry: NativeProcessRegistry, binary: string, environment?: NodeJS.ProcessEnv) {
  const scopes: ReturnType<NativeProcessRegistry['scope']>[] = []
  const closeRecovery = vi.fn(async (recovery: ReturnType<NativeProcessRegistry['scope']>) => {
    if (!await registry.closeOwner(recovery.owner)) throw new Error('Diagnostic native process closure is unconfirmed.')
  })
  const admitRecovery = vi.fn(async (recovery: ReturnType<NativeProcessRegistry['scope']>) => {
    Object.assign(recovery, await registry.reserveLaunch(recovery.owner))
  })
  const factories = new NativeHarnessFactories({ codexBinary: binary,
    auxiliaryRecovery: role => {
      const scope = registry.scope(`${role}:${scopes.length}`)
      scopes.push(scope)
      return scope
    },
    admitRecovery,
    abandonRecovery: async recovery => { await registry.abandonReservedLaunch(recovery) },
    closeRecovery,
  }, environment ? { mode: 'native', codex: { mode: 'native', environment: () => environment } } : { mode: 'native' })
  return { factories, scopes, admitRecovery, closeRecovery }
}

it.each([
  { code: 'ENOSPC', errno: -28 },
  { code: 'EDQUOT', errno: -122 },
  { code: 'Unknown system error -122', errno: -122 },
])('reports $code at reservation without dispatching or masking it with missing closure', async failure => {
  const f = await fixture()
  const registry = new NativeProcessRegistry(join(f.directory, 'recovery'))
  const owned = factoriesFor(registry, f.binary)
  const storageError = Object.assign(new Error('mkdir failed'), failure)
  vi.mocked(fs.mkdirSync).mockImplementationOnce(() => { throw storageError })
  try {
    await assert.rejects(owned.factories.qualifyConfiguration(DEFAULT_HARNESS_DEFAULTS.codex, f.directory),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'HARNESS_RECOVERY_STORAGE_FULL')
        assert.equal((error as Error).cause, storageError)
        assert.match((error as Error).message, /storage is full/)
        return true
      })
    assert.equal(owned.scopes[0]!.launchId, undefined)
    assert.equal(owned.closeRecovery.mock.calls.length, 0)
    assert.equal((await calls(f.directory)).length, 0)
    await owned.factories.disposeAuxiliaries()
    assert.equal(registry.snapshot().launches.length, 0)
    assert.equal(await registry.closeOwner(owned.scopes[0]!.owner), false)
  } finally {
    await owned.factories.disposeAuxiliaries()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('closes the retained reservation when admission fails after assigning its launch ID', async () => {
  const f = await fixture()
  const registry = new NativeProcessRegistry(join(f.directory, 'recovery'))
  const owned = factoriesFor(registry, f.binary)
  const failure = new Error('Admission failed after reservation.')
  owned.admitRecovery.mockImplementationOnce(async recovery => {
    Object.assign(recovery, await registry.reserveLaunch(recovery.owner))
    throw failure
  })
  try {
    await assert.rejects(owned.factories.qualifyConfiguration(DEFAULT_HARNESS_DEFAULTS.codex, f.directory),
      (error: unknown) => error === failure)
    const scope = owned.scopes[0]!
    assert.ok(scope.launchId)
    assert.equal((await calls(f.directory)).length, 0)
    assert.equal(await registry.closeOwner(scope.owner), true)
    assert.equal(registry.closedRegistration(scope.owner, scope.launchId)?.closureEvidence, 'native_not_started')
    assert.equal(owned.closeRecovery.mock.calls.length, 1)
  } finally {
    await owned.factories.disposeAuxiliaries()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it.each(['rename', 'directory-sync'] as const)('removes an undispatched reservation after failed %s publication', async stage => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-reservation-failure-'))
  const registry = new NativeProcessRegistry(root)
  const failure = Object.assign(new Error('reservation publication failed'), { code: 'EDQUOT', errno: -122 })
  if (stage === 'rename') vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw failure })
  else {
    let published = false
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      realFs.renameSync(source, destination)
      published = true
    })
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      if (published) {
        published = false
        throw failure
      }
      realFs.fsyncSync(fd)
    })
  }
  try {
    await assert.rejects(async () => registry.reserveLaunch('qualification-owner'), (error: unknown) => (error as { code?: string }).code === 'HARNESS_RECOVERY_STORAGE_FULL')
    assert.equal(registry.snapshot().launches.length, 0)
    assert.equal(await registry.closeOwner('qualification-owner'), false)
    vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync)
    vi.mocked(fs.fsyncSync).mockImplementation(realFs.fsyncSync)
    const retry = await registry.reserveLaunch('qualification-owner')
    assert.equal(await registry.abandonReservedLaunch(retry), true)
    assert.equal(await registry.closeOwner(retry.owner), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('closes sequential native Codex qualification processes under the admitted owner before returning a protocol refusal', async () => {
  const f = await fixture()
  const registry = new NativeProcessRegistry(join(f.directory, 'recovery'))
  const owned = factoriesFor(registry, f.binary)
  try {
    await assert.rejects(owned.factories.qualifyConfiguration(DEFAULT_HARNESS_DEFAULTS.codex, f.directory),
      (error: unknown) => errorCode(error) === 'CODEX_CONTRACT_UNSUPPORTED')
    const commands = (await calls(f.directory)).filter(entry => Array.isArray(entry.cli))
    assert.equal(commands.length, 3)
    assert.deepEqual(commands.slice(0, 2).map(entry => entry.cli), [['--version'], ['login', 'status']])
    const schemaCommand = commands[2]!.cli
    assert.ok(Array.isArray(schemaCommand))
    assert.deepEqual(schemaCommand.slice(0, 4), ['app-server', 'generate-json-schema', '--experimental', '--out'])
    assert.ok(owned.scopes[0]!.launchId)
    const launches = registry.snapshot().launches
    assert.equal(launches.length, 3)
    assert.ok(launches.every(launch => launch.owner === owned.scopes[0]!.owner && launch.lifecycle === 'closed'))
    assert.equal(await registry.closeOwner(owned.scopes[0]!.owner), true)
    assert.equal(owned.closeRecovery.mock.calls.length, 1)
  } finally {
    await owned.factories.disposeAuxiliaries()
    await rm(f.directory, { recursive: true, force: true })
  }
}, 30_000)

it('closes installed Codex qualification on Linux before returning an authentication refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-codex-cleanup-'))
  const codexHome = join(root, 'codex-home')
  await mkdir(codexHome, { mode: 0o700 })
  const binary = harnessBinaries(process.env).codexBinary
  const registry = new NativeProcessRegistry(join(root, 'recovery'))
  const owned = factoriesFor(registry, binary, { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome })
  try {
    await assert.rejects(owned.factories.qualifyConfiguration(DEFAULT_HARNESS_DEFAULTS.codex, root),
      (error: unknown) => {
        assert.equal(errorCode(error), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
        assert.match((error as Error).message, /Codex codex-cli \d+\.\d+\.\d+/)
        console.info('Installed Codex qualification refusal after cleanup:', (error as Error).message)
        return true
      })
    assert.ok(owned.scopes[0]!.launchId)
    const launches = registry.snapshot().launches
    assert.equal(launches.length, 2)
    assert.ok(launches.every(launch => launch.owner === owned.scopes[0]!.owner && launch.lifecycle === 'closed'
      && ['cgroup_v2_empty', 'native_exit_removed_cgroup'].includes(launch.closureEvidence ?? '')))
    assert.equal(await registry.closeOwner(owned.scopes[0]!.owner), true)
    assert.equal(owned.closeRecovery.mock.calls.length, 1)
  } finally {
    await owned.factories.disposeAuxiliaries()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
