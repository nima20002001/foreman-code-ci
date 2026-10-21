import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import assert from 'node:assert/strict'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, vi } from 'vitest'
import type { CodexHarnessConfiguration } from '@foreman-code/contracts'
import { CodexAppServerSessionManager, type CodexDiagnosticOperations, type CodexDiagnosticPin } from '../src/modules/harnesses/codexAppServer.js'
import { assertCodexUnchanged, codexBinaryIdentity } from '../src/modules/harnesses/codexProtocol.js'
import { qualifyNativeCodexModel } from '../src/modules/harnesses/codexQualification.js'
import { CodexStdioTransport } from '../src/modules/harnesses/codexStdioTransport.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { inheritedAgentEnvironment } from '../src/modules/harnesses/secrets.js'
import { calls, errorCode, fixture, fixtureProtocol, input, processesForRequests, state } from './fixtures/codex-test-helpers.js'

async function ownedFixture() {
  const f = await fixture()
  await writeFile(f.binary, (await readFile(f.binary, 'utf8')).replace('log({ cli: args })',
    `log({cli:args,hasAppToken:Boolean(process.env.FOREMAN_CODE_MCP_TOKEN || process.env.GRAPHQL_MCP_TOKEN),
      controllerVariables:Object.keys(process.env).filter(key => key.endsWith('DATABASE_URL')
        || key.startsWith('FOREMAN_CODE_TEST_') || key.startsWith('GRAPHQL_TEST_') || key === 'PGPASSWORD'),
      refreshedToken:(process.env.FOREMAN_CODE_MCP_TOKEN || process.env.GRAPHQL_MCP_TOKEN) === 'replacement-fixture-token'})`))
  const registry = new NativeProcessRegistry(join(f.directory, 'recovery'))
  const owner = 'idle-codex-owner'
  const recovery = registry.scope(owner)
  const diagnosticOwner = 'diagnostic-codex-fixture'
  const diagnosticRecovery = registry.scope(diagnosticOwner)
  const pins: CodexDiagnosticPin[] = []
  let failClose = false
  let schemaDrift = false
  const qualify = (scope: typeof recovery): CodexDiagnosticOperations['qualify'] =>
    async (binary, cwd, environment, _authentication, signal) => {
      const result = await runCommand(binary, ['--version'], cwd, signal, environment, { recovery: scope })
      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout.trim(), RECORDED_CODEX_VERSION)
      const path = await realpath(binary)
        return { binary: path, identity: await codexBinaryIdentity(path),
        providerVersion: RECORDED_CODEX_VERSION, protocol: fixtureProtocol,
        schemaManifestSha256: schemaDrift ? 'different-schema' : 'fixture-schema', stableSchemaGitBlob: 'fixture-stable', referenceSchemaManifestSha256: 'fixture-reference' }
    }
  // Replace only the fixture's deliberately unqualified schema. Real subprocesses
  // remain owned by the existing registry; diagnostic authority is separate.
  const manager = new CodexAppServerSessionManager(f.binary, undefined, undefined, recovery, undefined, undefined, {
    mode: 'native',
    transport: (...args) => {
      const transport = new CodexStdioTransport(...args)
      const close = transport.close.bind(transport)
      transport.close = async () => {
        if (failClose) { failClose = false; throw new Error('fixture unconfirmed cleanup') }
        await close()
      }
      return transport
    },
    qualify: qualify(recovery),
    withDiagnostics: async (pin, run) => {
      pin.signal?.throwIfAborted()
      pins.push(pin)
      try {
        return await run({
          qualify: qualify(diagnosticRecovery), assertUnchanged: assertCodexUnchanged,
          environment: (_input, names = []) => {
            const environment = inheritedAgentEnvironment()
            for (const name of [...pin.scopedCredentialVariables, ...names]) delete environment[name]
            return environment
          },
          runCommand: (binary, args, cwd, signal, environment, options) =>
            runCommand(binary, args, cwd, signal, environment, { ...options, recovery: diagnosticRecovery }),
          qualifyModel: (value, binary, cwd, environment, signal, _recovery, inspection) =>
            qualifyNativeCodexModel(value, binary, cwd, environment, signal, diagnosticRecovery, inspection),
        })
      } finally {
        assert.equal(await registry.closeOwner(diagnosticOwner), true, 'Diagnostic closure must be confirmed.')
      }
    },
  })
  return { ...f, registry, owner, recovery, diagnosticOwner, pins, manager,
    failNextClose: () => { failClose = true }, driftSchema: () => { schemaDrift = true } }
}

describe('Codex idle lifecycle with a populated recovery owner', () => {
  it('withholds controller credentials from launch and resume while delivering the scoped Agent token', async () => {
    const f = await ownedFixture()
    vi.stubEnv('SUBAGENT_CORE_ADMIN_DATABASE_URL', 'controller-database-sentinel')
    vi.stubEnv('HRT_F14_ADMIN_DATABASE_URL', 'controller-database-sentinel')
    vi.stubEnv('JOB_DISPATCH_DATABASE_URL', 'controller-database-sentinel')
    vi.stubEnv('FOREMAN_CODE_TEST_OPENAI_API_KEY', 'controller-key-sentinel')
    vi.stubEnv('FOREMAN_CODE_TEST_CODEX_AUTH_FILE', 'controller-auth-file-sentinel')
    try {
      const session = await f.manager.createSession(input(f.directory))
      await f.manager.refreshProcessEnvironment(session,
        { agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', FOREMAN_CODE_MCP_TOKEN: 'replacement-fixture-token' } })
      const launches = (await calls(f.directory)).filter(entry =>
        Array.isArray(entry.cli) && entry.cli[0] === 'app-server')
      for (const launch of launches) {
        assert.deepEqual(launch.controllerVariables, [])
      }
      const executionProcesses = await processesForRequests(f.directory, 'thread/start', 'thread/resume')
      assert.equal(executionProcesses.length, 2)
      const executionPids = new Set(executionProcesses.map(entry => entry.pid))
      const executionLaunches = launches.filter(entry => executionPids.has(entry.processPid))
      assert.equal(executionLaunches.length, 2)
      for (const launch of executionLaunches) {
        assert.equal(launch.hasAppToken, true)
      }
      for (const launch of launches.filter(entry => !executionPids.has(entry.processPid))) {
        assert.equal(launch.hasAppToken, false)
      }
      assert.equal(executionLaunches[1]!.refreshedToken, true)
      assert.equal((await state(f.directory, session.nativeSessionId)).id, session.nativeSessionId)
    } finally {
      vi.unstubAllEnvs()
      await f.manager.shutdown()
      assert.equal(await f.registry.closeOwner(f.owner), true)
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects controller credentials supplied as scoped Agent variables before native session launch', async () => {
    const f = await ownedFixture()
    try {
      const source = input(f.directory)
      source.environment = { ...source.environment!, variables: {
        ...source.environment!.variables, HRT_F14_ADMIN_DATABASE_URL: 'controller-database-sentinel',
      } }
      await assert.rejects(f.manager.createSession(source), error => errorCode(error) === 'CODEX_ENVIRONMENT_INVALID')
      assert.equal((await calls(f.directory)).filter(entry =>
        Array.isArray(entry.cli) && entry.cli[0] === 'app-server').length, 0)
    } finally {
      await f.manager.shutdown()
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 30_000)

  for (const operation of ['refresh', 'reload', 'reload-ephemeral'] as const) it(`${operation} retains the exact native session through owner-scoped inspection`, async () => {
    const f = await ownedFixture()
    try {
      const source = input(f.directory)
      if (operation === 'reload-ephemeral') (source.request.configuration.harness as CodexHarnessConfiguration).advanced!.sessionPersistence = 'ephemeral'
      const session = await f.manager.createSession(source)
      const beforeInspection = await calls(f.directory)
      const original = (await processesForRequests(f.directory, 'thread/start'))[0]!
      assert(typeof original.pid === 'number')
      // Idle turn state does not make a live app-server's cgroup empty.
      await assert.rejects(runCommand(f.binary, ['--version'], f.directory, undefined, undefined, { recovery: f.recovery }), /active or unconfirmed/)
      if (operation === 'refresh') await f.manager.refreshProcessEnvironment(session,
        { agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_MCP_TOKEN: 'replacement-fixture-token' } })
      else await f.manager.reloadNativeMcp(session)
      await f.manager.inspectConfiguration(session)
      assert.equal((await state(f.directory, session.nativeSessionId)).id, session.nativeSessionId)
      const wire = (await calls(f.directory)).flatMap((entry) => entry.wire ? [entry.wire as Record<string, unknown>] : [])
      assert.equal(wire.filter((entry) => entry.method === 'thread/start').length, 1)
      if (operation === 'refresh') {
        const resumed = wire.filter((entry) => entry.method === 'thread/resume')
        assert.equal(resumed.length, 1)
        assert.equal((resumed[0]!.params as Record<string, unknown>).threadId, session.nativeSessionId)
      }
      else {
        assert.equal(wire.filter((entry) => entry.method === 'config/mcpServer/reload').length, 1)
        assert.equal(wire.filter((entry) => entry.method === 'thread/resume').length, 0)
        assert.equal((await processesForRequests(f.directory, 'thread/start', 'thread/resume', 'thread/fork')).length, 1)
        const reload = (await calls(f.directory)).find(entry =>
          (entry.wire as Record<string, unknown> | undefined)?.method === 'config/mcpServer/reload')
        assert.equal(reload?.processPid, original.pid)
        process.kill(original.pid, 0)
      }
      assert.equal(await f.registry.closeOwner(f.diagnosticOwner), true)
      const sessionPids = new Set((await processesForRequests(f.directory, 'thread/start', 'thread/resume', 'thread/fork'))
        .map(entry => entry.pid))
      const inspectionCalls = (await calls(f.directory)).slice(beforeInspection.length)
      assert(inspectionCalls.filter(entry => Array.isArray(entry.cli) && !sessionPids.has(entry.processPid))
        .every(entry => entry.hasAppToken === false))
      for (const entry of await processesForRequests(f.directory, 'model/list')) {
        assert(typeof entry.pid === 'number')
        assert.throws(() => process.kill(entry.pid as number, 0), { code: 'ESRCH' })
      }
      assert((await calls(f.directory)).filter((entry) => Array.isArray(entry.cli) && entry.cli[0] !== 'app-server').every((entry) => entry.hasAppToken === false))
      await assert.rejects(runCommand(f.binary, ['--version'], f.directory, undefined, undefined, { recovery: f.recovery }), /active or unconfirmed/)
    } finally {
      await f.manager.shutdown()
      assert.equal(await f.registry.closeOwner(f.owner), true)
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects changed schema qualification without reloading or stopping the live session', async () => {
    const f = await ownedFixture()
    try {
      const session = await f.manager.createSession(input(f.directory))
      f.driftSchema()
      await assert.rejects(f.manager.reloadNativeMcp(session), (error) => errorCode(error) === 'CODEX_SESSION_QUALIFICATION_MISMATCH')
      assert.equal(await f.registry.closeOwner(f.diagnosticOwner), true)
      await f.manager.inspectConfiguration(session)
      assert.equal((await calls(f.directory)).filter((entry) => (entry.wire as Record<string, unknown> | undefined)?.method === 'config/mcpServer/reload').length, 0)
      await assert.rejects(runCommand(f.binary, ['--version'], f.directory, undefined, undefined, { recovery: f.recovery }), /active or unconfirmed/)
    } finally {
      await f.manager.shutdown()
      assert.equal(await f.registry.closeOwner(f.owner), true)
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps invalid credential refresh fenced and allows a corrected retry on the same native thread', async () => {
    const f = await ownedFixture()
    try {
      await writeFile(join(f.directory, 'no-mcp'), '')
      const source = input(f.directory)
      delete source.environment
      const session = await f.manager.createSession(source)
      await rm(join(f.directory, 'no-mcp'))
      await assert.rejects(f.manager.refreshProcessEnvironment(session, { agentId: 'agent-a', variables: {} }),
        (error) => errorCode(error) === 'CODEX_SCOPED_ENVIRONMENT_REQUIRED')
      await f.manager.refreshProcessEnvironment(session,
        { agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_MCP_TOKEN: 'replacement-fixture-token' } })
      await f.manager.inspectConfiguration(session)
      assert.equal((await state(f.directory, session.nativeSessionId)).id, session.nativeSessionId)
    } finally {
      await f.manager.shutdown()
      assert.equal(await f.registry.closeOwner(f.owner), true)
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the old writer fenced after unconfirmed replacement cleanup, and permits an explicit retry', async () => {
    const f = await ownedFixture()
    try {
      const source = input(f.directory)
      const session = await f.manager.createSession(source)
      f.failNextClose()
      await assert.rejects(f.manager.refreshProcessEnvironment(session, source.environment!), /unconfirmed cleanup/)
      assert.equal(await f.registry.closeOwner(f.diagnosticOwner), true)
      assert.equal((await calls(f.directory)).filter((entry) => (entry.wire as Record<string, unknown> | undefined)?.method === 'thread/resume').length, 0)
      await assert.rejects(runCommand(f.binary, ['--version'], f.directory, undefined, undefined, { recovery: f.recovery }), /active or unconfirmed/)
      await f.manager.refreshProcessEnvironment(session, source.environment!)
      await f.manager.inspectConfiguration(session)
      const resumed = (await calls(f.directory)).flatMap((entry) => {
        const wire = entry.wire as Record<string, unknown> | undefined
        return wire?.method === 'thread/resume' ? [wire] : []
      })
      assert.equal(resumed.length, 1)
      assert.equal((resumed[0]!.params as Record<string, unknown>).threadId, session.nativeSessionId)
    } finally {
      await f.manager.shutdown()
      assert.equal(await f.registry.closeOwner(f.owner), true)
      await rm(f.directory, { recursive: true, force: true })
    }
  }, 30_000)
})
