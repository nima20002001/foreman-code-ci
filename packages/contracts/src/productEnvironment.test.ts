import { describe, expect, it } from 'vitest'
import { HarnessMcpConnectionSchema } from './management/harnessSettings.js'
import { readProductEnvironment, resolveProductEnvironment } from './productEnvironment.mjs'

describe('product environment aliases', () => {
  it('preserves defaults and accepts either name or equal effective values', () => {
    expect(readProductEnvironment({}, 'WEB_PORT')).toBeUndefined()
    expect(readProductEnvironment({ GRAPHQL_WEB_PORT: '5198' }, 'WEB_PORT')).toBe('5198')
    expect(readProductEnvironment({ FOREMAN_CODE_WEB_PORT: '5198' }, 'WEB_PORT')).toBe('5198')
    expect(readProductEnvironment({ FOREMAN_CODE_WEB_PORT: '5198', GRAPHQL_WEB_PORT: '05198' }, 'WEB_PORT')).toBe('5198')
    expect(readProductEnvironment({ FOREMAN_CODE_BROWSER_ORIGIN: 'http://localhost:5198/',
      GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5198' }, 'BROWSER_ORIGIN')).toBe('http://localhost:5198/')
    expect(resolveProductEnvironment({ GRAPHQL_LAPTOP_EXECUTION_ENABLED: '0' })).toEqual({ FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '0' })
  })

  it('rejects conflicting configuration and never includes secret values', () => {
    expect(() => readProductEnvironment({ FOREMAN_CODE_WEB_PORT: '5198', GRAPHQL_WEB_PORT: '5199' }, 'WEB_PORT'))
      .toThrow('FOREMAN_CODE_WEB_PORT conflicts with GRAPHQL_WEB_PORT')
    const read = () => readProductEnvironment({ FOREMAN_CODE_MCP_TOKEN: 'canonical-private-token', GRAPHQL_MCP_TOKEN: 'legacy-private-token' }, 'MCP_TOKEN')
    expect(read).toThrow('FOREMAN_CODE_MCP_TOKEN conflicts with GRAPHQL_MCP_TOKEN')
    try { read() } catch (error) {
      expect(String(error)).not.toContain('canonical-private-token')
      expect(String(error)).not.toContain('legacy-private-token')
    }
  })

  it('keeps process precedence across spellings and validates the selected layer', () => {
    expect(resolveProductEnvironment({ GRAPHQL_WEB_PORT: '5198', DATABASE_URL: 'process-db' },
      { FOREMAN_CODE_WEB_PORT: '5199', DATABASE_URL: 'file-db' }))
      .toEqual({ FOREMAN_CODE_WEB_PORT: '5198', DATABASE_URL: 'process-db' })
    expect(resolveProductEnvironment({ FOREMAN_CODE_WEB_PORT: '5198' }, { GRAPHQL_WEB_PORT: '5199' }))
      .toEqual({ FOREMAN_CODE_WEB_PORT: '5198' })
    expect(() => resolveProductEnvironment({}, { FOREMAN_CODE_WEB_PORT: '5198', GRAPHQL_WEB_PORT: '5199' })).toThrow('conflicts')
  })

  it.each(['API_ENV_FILE', 'HEAVY_BASE_TMPDIR', 'HEAVY_JOB_COMMON'])('preserves exact filesystem settings for %s', suffix => {
    expect(() => readProductEnvironment({ [`FOREMAN_CODE_${suffix}`]: '/tmp/installation',
      [`GRAPHQL_${suffix}`]: '/tmp/installation ' }, suffix)).toThrow('conflicts')
  })

  it.each(['LAPTOP_EXECUTION_ENABLED', 'DEVICE_LISTENER_ENABLED', 'ENABLE_EXPERIMENTAL_CODEX_APP_SERVER'])(
    'preserves strict opt-in values for %s', suffix => {
      expect(() => readProductEnvironment({ [`FOREMAN_CODE_${suffix}`]: '1',
        [`GRAPHQL_${suffix}`]: '1 ' }, suffix)).toThrow('conflicts')
    },
  )
})

it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])('keeps %s behind the managed credential boundary', name => {
  expect(HarnessMcpConnectionSchema.safeParse({ transport: 'remote', url: 'http://127.0.0.1:3000/mcp',
    bearerTokenEnvironmentVariable: name }).success).toBe(false)
})
