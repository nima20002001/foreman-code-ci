import { rm, writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { parseCodexModelCatalog, readNativeCodexModelCatalog, type CodexModelInspection } from '../src/modules/harnesses/codexModelCatalog.js'
import { qualifyNativeCodexModel } from '../src/modules/harnesses/codexQualification.js'
import { calls, fixture, fixtureQualification, fixtureProtocol } from './fixtures/codex-test-helpers.js'
import { join } from 'node:path'

const model = { slug: 'test-model', supported_reasoning_levels: [{ effort: 'medium' }],
  additional_speed_tiers: ['fast'] }
const result = (models: unknown, stderr = '') => ({ exitCode: 0, stdout: JSON.stringify({ models }), stderr })
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true }))) })

it('retains valid cached catalogs after remote refresh fails without exposing provider stderr', () => {
  const stderr = 'ERROR models_manager: failed to refresh available models: private provider detail'
  for (const models of [[], [model]]) {
    expect(parseCodexModelCatalog(result(models, stderr))).toEqual({ models, modelCatalogSource: 'cached' })
  }
})

it('keeps successful discovery when only native cache loading or saving fails', () => {
  const catalog = result([model], 'Failed to read models cache\nFailed to persist models cache')
  expect(parseCodexModelCatalog(catalog).models).toEqual([model])
})

it.each([undefined, null, {}, [null], ['test-model'], [{ slug: 'test-model' }],
  [{ ...model, supported_reasoning_levels: ['medium'] }],
  [{ ...model, additional_speed_tiers: [1] }], [model, model]])(
  'rejects malformed or ambiguous native catalogs without silently discarding entries: %j', models => {
    expect(() => parseCodexModelCatalog(result(models))).toThrow(expect.objectContaining({
      result: expect.objectContaining({ error: expect.objectContaining({ code: 'CODEX_MODEL_CATALOG_INVALID' }) }),
    }))
  })

it('bounds native catalog size and preserves the parse cause', () => {
  expect(() => parseCodexModelCatalog(result(Array.from({ length: 10_001 }, () => model))))
    .toThrow(expect.objectContaining({ result: expect.objectContaining({
      error: expect.objectContaining({ code: 'CODEX_MODEL_CATALOG_INVALID' }),
    }) }))
  expect(() => parseCodexModelCatalog({ exitCode: 0, stdout: '{', stderr: '' }))
    .toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }))
})

async function native(models: unknown, refreshFlag?: string) {
  const f = await fixture()
  directories.push(f.directory)
  await writeFile(join(f.directory, 'models.json'), JSON.stringify({ models }))
  if (refreshFlag) await writeFile(join(f.directory, refreshFlag), '')
  const qualified = await fixtureQualification(f.binary, f.directory, {}, true)
  return { ...f, inspection: { qualified, assertUnchanged: async () => undefined } }
}

it('checks the exact model, effort and tier through validated stdio without creating an inference thread', async () => {
  const f = await native([model])
  const configuration: CodexHarnessConfiguration = { ...DEFAULT_HARNESS_DEFAULTS.codex, model: model.slug,
    reasoningEffort: 'medium', serviceTier: 'priority' as const }
  const qualify = (value: CodexHarnessConfiguration) => qualifyNativeCodexModel(value,
    f.binary, f.directory, {}, undefined, undefined, f.inspection)
  await qualify(configuration)
  await expect(qualify({ ...configuration, model: 'absent' }))
    .rejects.toMatchObject({ result: { error: { code: 'CODEX_MODEL_UNAVAILABLE',
      message: expect.stringContaining(f.inspection.qualified.providerVersion) } } })
  await expect(qualify({ ...configuration, reasoningEffort: 'high' }))
    .rejects.toMatchObject({ result: { error: { code: 'CODEX_SETTING_UNSUPPORTED',
      message: expect.stringContaining('model/list') } } })
  const wire = (await calls(f.directory)).filter(entry => entry.wire).map(entry => entry.wire as { method: string })
  expect(wire.filter(entry => entry.method === 'model/list')).toHaveLength(3)
  expect(wire.some(entry => ['thread/start', 'thread/resume', 'turn/start'].includes(entry.method))).toBe(false)
  expect(configuration.model).toBe('test-model')
})

it.each(['models-refresh-failed', 'models-refresh-failed-on-close'])(
  'qualifies cached models after stderr is drained, without inference or another model read: %s', async flag => {
    const f = await native([model], flag)
    await expect(qualifyNativeCodexModel({ ...DEFAULT_HARNESS_DEFAULTS.codex,
      model: model.slug, reasoningEffort: 'medium' }, f.binary, f.directory, {}, undefined, undefined, f.inspection))
      .resolves.toMatchObject({ modelCatalogSource: 'cached' })
    const wire = (await calls(f.directory)).filter(entry => entry.wire).map(entry => entry.wire as { method: string })
    expect(wire.filter(entry => entry.method === 'model/list')).toHaveLength(1)
    expect(wire.some(entry => ['thread/start', 'thread/resume', 'turn/start'].includes(entry.method))).toBe(false)
  })

it('drains late stdout during metadata cleanup without treating it as transcript content', async () => {
  const f = await native([model], 'models-late-stdout')
  await qualifyNativeCodexModel({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: model.slug,
    reasoningEffort: 'medium' }, f.binary, f.directory, {}, undefined, undefined, f.inspection)
  const wire = (await calls(f.directory)).filter(entry => entry.wire).map(entry => entry.wire as { method: string })
  expect(wire.filter(entry => entry.method === 'model/list')).toHaveLength(1)
  expect(wire.some(entry => entry.method === 'thread/start')).toBe(false)
})

function recordedInspection(request: () => Promise<unknown>, close: () => Promise<void>): CodexModelInspection {
  return { qualified: { binary: '/recorded-codex', identity: 'recorded', protocol: fixtureProtocol,
    providerVersion: 'codex-cli 0.154.0', schemaManifestSha256: 'recorded', stableSchemaGitBlob: 'recorded',
    referenceSchemaManifestSha256: 'recorded' }, assertUnchanged: async () => undefined,
    runCommand: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),
    transportFactory: () => ({ start: async () => undefined, reject: async () => undefined, request, close }) }
}

it.each([null, { model: 'test-model' }])(
  'reports a missing native model capability with its observed version and confirms cleanup: %j', async model => {
    let closed = false
    const inspection = recordedInspection(async () => ({ data: [model], nextCursor: null }),
      async () => { closed = true })
    inspection.qualified.providerVersion = 'codex-cli 0.160.0'
    await expect(readNativeCodexModelCatalog(inspection, '/recorded-workspace', {}))
      .rejects.toMatchObject({ result: { error: { code: 'CODEX_MODEL_CATALOG_INVALID',
        message: expect.stringContaining(inspection.qualified.providerVersion) } } })
    expect(closed).toBe(true)
  })

it.each([
  { configured: [], disabled: [] },
  { configured: ['foreman-code'], disabled: ['foreman-code'] },
  { configured: ['graphql'], disabled: ['graphql'] },
  { configured: ['graphql-app', 'graphql-operator'], disabled: ['graphql-app', 'graphql-operator'] },
  { configured: ['other-server'], disabled: [] },
])('isolates model metadata and disables only configured App MCP entries: $configured', async ({ configured, disabled }) => {
  const source = { CODEX_HOME: '/private-provider-profile', OPENAI_API_KEY: 'provider-fixture-key',
    FOREMAN_CODE_MCP_TOKEN: 'scoped-fixture-token', GRAPHQL_MCP_TOKEN: 'legacy-scoped-token',
    JOB_DISPATCH_DATABASE_URL: 'controller-database', FOREMAN_CODE_TEST_OWNER: 'controller-owner',
    NODE_OPTIONS: '--import=controller-loader' }
  const inspection = recordedInspection(async () => ({ data: [], nextCursor: null }), async () => undefined)
  const factory = inspection.transportFactory!
  let delivered: NodeJS.ProcessEnv | undefined
  let commandEnvironment: NodeJS.ProcessEnv | undefined
  let disabledMcp: readonly string[] | undefined
  inspection.runCommand = async (binary, args, cwd, _signal, environment) => {
    expect(binary).toBe(inspection.qualified.binary)
    expect(args).toEqual(['mcp', 'list', '--json'])
    expect(cwd).toBe('/recorded-workspace')
    commandEnvironment = environment as NodeJS.ProcessEnv
    return { exitCode: 0, stdout: JSON.stringify(configured.map(name => ({ name }))), stderr: '' }
  }
  inspection.transportFactory = (...args) => {
    delivered = args[2]
    disabledMcp = args[9]
    return factory(...args)
  }
  await readNativeCodexModelCatalog(inspection, '/recorded-workspace', source)
  expect(delivered).toMatchObject({ CODEX_HOME: source.CODEX_HOME, OPENAI_API_KEY: source.OPENAI_API_KEY })
  expect(commandEnvironment).toMatchObject({ CODEX_HOME: source.CODEX_HOME, OPENAI_API_KEY: source.OPENAI_API_KEY })
  expect(disabledMcp).toEqual(disabled)
  for (const key of ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN', 'JOB_DISPATCH_DATABASE_URL',
    'FOREMAN_CODE_TEST_OWNER', 'NODE_OPTIONS']) {
    expect(delivered?.[key]).toBeUndefined()
    expect(commandEnvironment?.[key]).toBeUndefined()
  }
  expect(source.FOREMAN_CODE_MCP_TOKEN).toBe('scoped-fixture-token')
  expect(source.NODE_OPTIONS).toBe('--import=controller-loader')
})

it.each(['{', '{}', '[null]', '[{"name":2}]'])(
  'refuses model startup when configured MCP entries cannot be established: %s', async stdout => {
    const inspection = recordedInspection(async () => ({ data: [], nextCursor: null }), async () => undefined)
    inspection.runCommand = async () => ({ exitCode: 0, stdout, stderr: '' })
    let started = false
    inspection.transportFactory = () => {
      started = true
      throw new Error('Invalid MCP inspection must not start the metadata transport.')
    }
    await expect(readNativeCodexModelCatalog(inspection, '/recorded-workspace', {}))
      .rejects.toMatchObject({ result: { error: { code: 'CODEX_MCP_INSPECTION_FAILED' } } })
    expect(started).toBe(false)
  })

it('rejects empty continuation pages and confirms cleanup without unbounded metadata reads', async () => {
  let reads = 0
  let closed = false
  const inspection = recordedInspection(async () => {
    reads += 1
    return { data: [], nextCursor: `cursor-${reads}` }
  }, async () => { closed = true })
  await expect(readNativeCodexModelCatalog(inspection, '/recorded-workspace', {}))
    .rejects.toMatchObject({ result: { error: { code: 'CODEX_MODEL_CATALOG_INVALID',
      message: expect.stringContaining(inspection.qualified.providerVersion) } } })
  expect(reads).toBe(1)
  expect(closed).toBe(true)
})

it('does not publish a catalog when the caller cancels during confirmed cleanup', async () => {
  let closing!: () => void
  const beganClosing = new Promise<void>(resolve => { closing = resolve })
  let release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const controller = new AbortController()
  const inspection = recordedInspection(async () => ({ data: [], nextCursor: null }), async () => {
    closing()
    await cleanup
  })
  const read = readNativeCodexModelCatalog(inspection, '/recorded-workspace', {}, controller.signal)
  const rejected = expect(read).rejects.toThrow('canceled metadata inspection')
  await beganClosing
  controller.abort(new Error('canceled metadata inspection'))
  release()
  await rejected
})
