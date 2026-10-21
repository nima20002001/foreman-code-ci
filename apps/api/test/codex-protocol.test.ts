import assert from 'node:assert/strict'
import { appendFile, link, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { assertCodexUnchanged, codexBinaryIdentity, qualifyCodex, type QualifiedCodex } from '../src/modules/harnesses/codexProtocol.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { calls, errorCode, fixture, fixtureProtocol, type Fixture } from './fixtures/codex-test-helpers.js'
import { codexSchema } from './fixtures/harness-schemas.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { nativeCompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { CompatibilityCheckError } from '../src/modules/harnesses/compatibility/errors.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import * as nativeProcess from '../src/modules/harnesses/process.js'

let f: Fixture
const newer = 'codex-cli 0.160.0'
async function configure(schema = codexSchema()) {
  await writeFile(join(f.directory, 'version.json'), JSON.stringify(newer))
  await writeFile(join(f.directory, 'schema.json'), JSON.stringify(schema))
}
async function qualify(authenticated = false) {
  return qualifyCodex(f.binary, f.directory, { ...process.env }, authenticated)
}
async function schemaCalls() {
  return (await calls(f.directory)).filter(entry => Array.isArray(entry.cli) && entry.cli.includes('generate-json-schema'))
}

describe.skipIf(process.platform === 'win32')('Codex installed contract verification', () => {
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { await removeFixtureDirectory(f.directory) })

  it('accepts a newer compatible binary and records its observed version', async () => {
    await configure()
    const result = await qualify()
    assert.equal(result.providerVersion, newer)
    assert.match(result.schemaManifestSha256, /^[a-f0-9]{64}$/)
    assert.equal((await schemaCalls()).length, 1)
    await qualify()
    assert.equal((await schemaCalls()).length, 1)
  })

  it('probes version once per executable identity and reprobes after replacement', async () => {
    await configure()
    await qualify()
    await qualify()
    const versionCalls = async () => (await calls(f.directory))
      .filter(entry => Array.isArray(entry.cli) && entry.cli.includes('--version'))
    assert.equal((await versionCalls()).length, 1)
    await appendFile(f.binary, '\n// changed executable\n')
    await qualify()
    assert.equal((await versionCalls()).length, 2)
  })

  it('names the harness, observed version and missing required method', async () => {
    const schema = codexSchema()
    schema.definitions.ClientRequest.oneOf = schema.definitions.ClientRequest.oneOf.filter(
      branch => branch.properties.method.const !== 'thread/resume')
    await configure(schema)
    await assert.rejects(qualify(), error => error instanceof Error
      && error.message.includes(newer) && error.message.includes('thread/resume')
      && errorCode(error) === 'CODEX_CONTRACT_UNSUPPORTED')
  })

  it('preserves a schema command timeout instead of reporting an unsupported contract', async () => {
    await configure()
    const timeout = new DOMException('Schema command deadline exceeded.', 'TimeoutError')
    const command = nativeProcess.runCommand
    const spy = vi.spyOn(nativeProcess, 'runCommand').mockImplementation((binary, args, ...rest) => {
      if (args.includes('generate-json-schema')) return Promise.reject(timeout)
      return command(binary, args, ...rest)
    })
    try {
      await assert.rejects(qualify(), error => error === timeout)
    } finally {
      spy.mockRestore()
    }
  })

  it('names a missing history response field on the installed version', async () => {
    const schema = codexSchema()
    Reflect.deleteProperty(schema.definitions.v2.ThreadReadResponse.properties, 'thread')
    await configure(schema)
    await assert.rejects(qualify(), error => error instanceof Error
      && error.message.includes(newer) && error.message.includes('ThreadReadResponse.thread'))
  })

  it('accepts a newer schema with optional settings and verifies the actual response', async () => {
    const schema = codexSchema()
    for (const response of [schema.definitions.v2.ThreadStartResponse, schema.definitions.v2.ThreadResumeResponse]) {
      response.required = response.required.filter(name => name !== 'reasoningEffort')
    }
    await configure(schema)
    const qualified = await qualify()
    const response = { thread: { id: 'thread', turns: [] }, model: 'model', modelProvider: 'openai', cwd: f.directory,
      sandbox: {}, approvalPolicy: 'never', approvalsReviewer: 'user', reasoningEffort: 'medium', serviceTier: null }
    assert.doesNotThrow(() => qualified.protocol.response('thread/start', response))
    Reflect.deleteProperty(response, 'reasoningEffort')
    assert.throws(() => qualified.protocol.response('thread/start', response), /0.160.0.*reasoningEffort/)
  })

  it('accepts a referenced sandbox union inside allOf and validates the observed policy', async () => {
    const schema = codexSchema()
    Object.assign(schema.definitions.v2, { SandboxPolicy: {
      oneOf: ['readOnly', 'workspaceWrite'].map(type => ({
        type: 'object', properties: { type: { const: type, type: 'string' } }, required: ['type'],
      })),
    } })
    for (const response of [schema.definitions.v2.ThreadStartResponse, schema.definitions.v2.ThreadResumeResponse,
      schema.definitions.v2.ThreadForkResponse]) {
      Object.assign(response.properties, { sandbox: { allOf: [{ $ref: '#/definitions/v2/SandboxPolicy' }] } })
    }
    await configure(schema)
    const qualified = await qualify()
    const response = { thread: { id: 'thread', turns: [] }, model: 'model', modelProvider: 'openai', cwd: f.directory,
      sandbox: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user',
      reasoningEffort: 'medium', serviceTier: null }
    assert.doesNotThrow(() => qualified.protocol.response('thread/start', response))
    assert.throws(() => qualified.protocol.response('thread/start', { ...response, sandbox: { type: 'unknown' } }),
      /0.160.0.*ThreadStartResponse/)
    assert.throws(() => qualified.protocol.response('thread/start', { ...response, sandbox: 'readOnly' }),
      /0.160.0.*ThreadStartResponse/)
  })

  it('reverifies a changed binary even when its reported version is unchanged', async () => {
    await configure()
    const original = await qualify()
    await appendFile(f.binary, '\n// replacement payload\n')
    await assert.rejects(assertCodexUnchanged(original), error => errorCode(error) === 'CODEX_EXECUTABLE_CHANGED')
    const replacement = await qualify()
    assert.notEqual(replacement.identity, original.identity)
    assert.equal((await schemaCalls()).length, 2)
  })

  it('requires authentication on cache hits and allows logged-out model-free control checks', async () => {
    await configure()
    await qualify(true)
    await writeFile(join(f.directory, 'logged-out'), '')
    await assert.rejects(qualify(true), error => errorCode(error) === 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await qualify(false)
    assert.equal((await schemaCalls()).length, 1)
  })

  it.skipIf(process.platform !== 'linux')('attributes verification to the owned recovery scope and closes it', async () => {
    await configure()
    const registry = new NativeProcessRegistry(join(f.directory, 'qualification-recovery'))
    const owner = 'codex-qualification-owner'
    const scope = registry.scope(owner)
    assert.equal(await registry.closeOwner(owner), false)
    const environment = { ...process.env,
      NODE_OPTIONS: '--import=data:text/javascript,throw%20new%20Error(%22controller%20bootstrap%22)' }
    const version = await runCommand(f.binary, ['--version'], f.directory, undefined, environment, { recovery: scope })
    assert.equal(version.exitCode, 0, `Owned version probe failed: ${version.stderr}`)
    assert.equal(version.stdout.trim(), newer)
    await qualifyCodex(f.binary, f.directory, environment, true, undefined, scope)
    assert.equal(await registry.closeOwner(owner), true)
  })
  it('F27: executable replacement invalidates previously measured identity before spawn', async () => {
    const path = await realpath(f.binary)
    const info = await stat(path)
    const qualified: QualifiedCodex = {
      binary: path, identity: await codexBinaryIdentity(path), protocol: fixtureProtocol,
      providerVersion: newer, schemaManifestSha256: 'test-only', stableSchemaGitBlob: 'test-only', referenceSchemaManifestSha256: 'test-only',
    }
    await assertCodexUnchanged(qualified)
    await appendFile(path, '\n// executable replacement\n')
    await utimes(path, info.atime, info.mtime)
    await assert.rejects(assertCodexUnchanged(qualified), (error: unknown) => errorCode(error) === 'CODEX_EXECUTABLE_CHANGED')
  })

  it('keeps executable qualification when another worktree creates a hardlink', async () => {
    const path = await realpath(f.binary)
    const qualified: QualifiedCodex = {
      binary: path, identity: await codexBinaryIdentity(path), protocol: fixtureProtocol,
      providerVersion: newer, schemaManifestSha256: 'test-only',
      stableSchemaGitBlob: 'test-only', referenceSchemaManifestSha256: 'test-only',
    }
    await link(path, join(f.directory, 'worktree-installation'))
    await assertCodexUnchanged(qualified)
  })

  it('keeps diagnostic identity across hardlinks and rejects changed executable content', async () => {
    const probe = nativeCompatibilityProbe({ codex: f.binary }, f.directory, process.env)
    const signal = AbortSignal.timeout(5000)
    try {
      const installed = await probe.inspect('codex', signal)
      await link(f.binary, join(f.directory, 'diagnostic-installation'))
      await probe.assertUnchanged(installed, signal)
      await appendFile(f.binary, '\n// executable replacement\n')
      await assert.rejects(probe.assertUnchanged(installed, signal), (error: unknown) =>
        error instanceof CompatibilityCheckError && error.code === 'CLI_CHANGED')
    } finally { await probe.close?.() }
  })
})

it('canonical objects ignore property order without changing array semantics', () => {
  assert.equal(canonicalJsonNumericKeysFirstLegacy({ b: { d: 4, c: 3 }, a: 1 }), canonicalJsonNumericKeysFirstLegacy({ a: 1, b: { c: 3, d: 4 } }))
  assert.notEqual(canonicalJsonNumericKeysFirstLegacy(['a', 'b']), canonicalJsonNumericKeysFirstLegacy(['b', 'a']))
})
