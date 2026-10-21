import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runCommand } from '../src/modules/harnesses/process.js'
import { appMcpTokenEnvironment, inheritedAgentEnvironment, nativeAgentEnvironment } from '../src/modules/harnesses/secrets.js'
import { safeEnvironment } from '../src/modules/harnesses/codexAppServer.js'

afterEach(() => vi.unstubAllEnvs())

it('keeps provider credentials and native login paths while excluding production database credentials', () => {
  const source = {
    HOME: '/home/operator', XDG_DATA_HOME: '/home/operator/.local/share',

    GRAPHQL_PRODUCTION_DB_PASSWORD: 'production-database-credential',
    DATABASE_URL: 'postgresql://owner:credential@localhost/graphql_production',
    TEST_DATABASE_URL: 'postgresql://test:credential@localhost/graphql_test',
    NIM2691_ADMIN_DATABASE_URL: 'postgresql://admin:credential@localhost/postgres',
    HRT_F14_ADMIN_DATABASE_URL: 'postgresql://admin:credential@localhost/postgres',
    ENG03_A_TEST_DATABASE_URL: 'postgresql://test:credential@localhost/graphql_native_test',
    JOB_DISPATCH_DATABASE_URL: 'postgresql://job:credential@localhost/graphql_job_test',
    PGPASSWORD: 'database-credential', GRAPHQL_MCP_TOKEN: 'unscoped-app-credential',
  }
  assert.deepEqual(inheritedAgentEnvironment(source), {
    HOME: source.HOME, XDG_DATA_HOME: source.XDG_DATA_HOME,

    NO_COLOR: '1',
  })
  assert.equal(source.GRAPHQL_PRODUCTION_DB_PASSWORD, 'production-database-credential')
})

it('withholds database selectors and test-controller credentials from native agents', () => {
  const source = {
    DATABASE_URL: 'postgresql://test/database',
    TEST_DATABASE_URL: 'postgresql://test/database',
    SUBAGENT_CORE_ADMIN_DATABASE_URL: 'postgresql://test/database',
    HRT_F03_DATABASE_URL: 'postgresql://test/database',
    PGPASSWORD: 'controller-password',
    FOREMAN_CODE_TEST_OWNER: 'controller-owner',
    FOREMAN_CODE_TEST_OPENAI_API_KEY: 'test-key-alias',
    NODE_OPTIONS: '--import=controller-bootstrap.mjs',
    OPENAI_API_KEY: 'explicit-provider-key',
    HOME: '/private/native-home',
  }
  const environment = inheritedAgentEnvironment(source)
  for (const key of Object.keys(source)) {
    if (key === 'OPENAI_API_KEY' || key === 'HOME') continue
    assert.equal(environment[key], undefined)
  }
  assert.equal(environment.OPENAI_API_KEY, source.OPENAI_API_KEY)
  assert.equal(environment.HOME, source.HOME)
  assert.equal(source.HRT_F03_DATABASE_URL, 'postgresql://test/database')
})

it('starts native children with their binary directory first and removes pnpm bin directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-path-'))
  const output = join(directory, 'path.txt')
  const source = { ...process.env, PATH: [
    join(process.cwd(), 'node_modules', '.bin'),
    join(process.cwd(), 'apps', 'api', 'node_modules', '.bin'),
    '/usr/local/bin',
  ].join(delimiter) }
  assert.equal(nativeAgentEnvironment(process.execPath, process.cwd(), { ...source, GRAPHQL_MCP_TOKEN: 'scoped-token' }).GRAPHQL_MCP_TOKEN,
    'scoped-token')
  try {
    const result = await runCommand(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.env.PATH || "")', output],
      process.cwd(), AbortSignal.timeout(5_000), source)
    assert.equal(result.exitCode, 0)
    const paths = (await readFile(output, 'utf8')).split(delimiter)
    assert.equal(paths[0], dirname(process.execPath))
    assert.ok(paths.includes('/usr/local/bin'))
    assert.ok(paths.every((entry) => !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(entry)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('strips both ambient credential namespaces and only aliases an admitted native token', () => {
  const clean = inheritedAgentEnvironment({ GRAPHQL_MCP_TOKEN: 'ambient-old', FOREMAN_CODE_MCP_TOKEN: 'ambient-new',
    GRAPHQL_PRODUCTION_DB_PASSWORD: 'database-old', FOREMAN_CODE_PRODUCTION_DB_PASSWORD: 'database-new',
    FOREMAN_CODE_OPERATOR_SECRET: 'operator-secret', FOREMAN_CODE_APP_SECRET: 'app-secret', PATH: '/usr/bin' })
  expect(clean).toEqual({ PATH: '/usr/bin', NO_COLOR: '1' })
  const runtime = { FOREMAN_CODE_APP_MCP_DIRECTORY: '/runtime/mcp' }
  expect(appMcpTokenEnvironment({ GRAPHQL_MCP_TOKEN: 'admitted' }, runtime)).toEqual({
    GRAPHQL_MCP_TOKEN: 'admitted', FOREMAN_CODE_MCP_TOKEN: 'admitted', FOREMAN_CODE_APP_MCP_DIRECTORY: '/runtime/mcp',
  })
  expect(() => appMcpTokenEnvironment({ GRAPHQL_MCP_TOKEN: 'old', FOREMAN_CODE_MCP_TOKEN: 'new' }, runtime)).toThrow('conflicts')
})

it.each(['GRAPHQL_APP_MCP_DIRECTORY', 'FOREMAN_CODE_APP_MCP_DIRECTORY'])(
  'withholds the bridge configured by %s from Codex until MCP admission', directoryName => {
    vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', undefined)
    vi.stubEnv(directoryName, '/runtime/mcp')
    vi.stubEnv('GRAPHQL_MCP_TOKEN', 'ambient-token')
    vi.stubEnv('FOREMAN_CODE_MCP_TOKEN', 'ambient-token')
    const clean = safeEnvironment()
    expect(clean.FOREMAN_CODE_APP_MCP_DIRECTORY).toBeUndefined()
    expect(clean.GRAPHQL_APP_MCP_DIRECTORY).toBeUndefined()
    expect(clean.FOREMAN_CODE_MCP_TOKEN).toBeUndefined()
    expect(clean.GRAPHQL_MCP_TOKEN).toBeUndefined()
    const admitted = safeEnvironment({ agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: 'admitted-token' } })
    expect(admitted.FOREMAN_CODE_APP_MCP_DIRECTORY).toBe('/runtime/mcp')
    expect(admitted.GRAPHQL_APP_MCP_DIRECTORY).toBeUndefined()
    expect(admitted.FOREMAN_CODE_MCP_TOKEN).toBe('admitted-token')
    expect(admitted.GRAPHQL_MCP_TOKEN).toBe('admitted-token')
  },
)

for (const directoryName of ['GRAPHQL_APP_MCP_DIRECTORY', 'FOREMAN_CODE_APP_MCP_DIRECTORY']) {
  it.each([false, true])(`delivers the ${directoryName} bridge to a native child only with admitted MCP access (%s)`, async admitted => {
    const source = { [directoryName]: '/runtime/mcp', GRAPHQL_MCP_TOKEN: 'ambient-token',
      FOREMAN_CODE_MCP_TOKEN: 'ambient-token', FOREMAN_CODE_APP_SECRET: 'ambient-secret' }
    vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', undefined)
    for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value)
    const environmentOrScope = admitted ? {
      expectedAgentId: 'agent',
      beforeSpawn: async () => ({ agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: 'admitted-token' } }),
    } : source
    const result = await runCommand(process.execPath, ['-e', `console.log(JSON.stringify({
      directory: process.env.FOREMAN_CODE_APP_MCP_DIRECTORY,
      legacyDirectory: process.env.GRAPHQL_APP_MCP_DIRECTORY,
      token: process.env.FOREMAN_CODE_MCP_TOKEN,
      legacyToken: process.env.GRAPHQL_MCP_TOKEN,
      secret: process.env.FOREMAN_CODE_APP_SECRET,
    }))`], process.cwd(), AbortSignal.timeout(5_000), environmentOrScope)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(admitted
      ? { directory: '/runtime/mcp', token: '[REDACTED]', legacyToken: '[REDACTED]' }
      : {})
  })
}

it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])('delivers the scoped %s token to installed native entries using either name', async name => {
  const result = await runCommand(process.execPath,
    ['-e', 'console.log(JSON.stringify({old:process.env.GRAPHQL_MCP_TOKEN,new:process.env.FOREMAN_CODE_MCP_TOKEN}))'],
    process.cwd(), AbortSignal.timeout(5_000), {
      expectedAgentId: 'scoped-agent', beforeSpawn: async () => ({ agentId: 'scoped-agent', variables: { [name]: 'admitted-token' } }),
    })
  expect(result.exitCode).toBe(0)
  // The process helper redacts both delivered spellings from native output.
  expect(JSON.parse(result.stdout)).toEqual({ old: '[REDACTED]', new: '[REDACTED]' })
})
