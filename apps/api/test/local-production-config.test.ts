import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'

const environment = { NODE_ENV: 'production', GRAPHQL_LOCAL_PRODUCTION: '1', HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://owner:password@127.0.0.1:55440/graphql_production' }

it('defaults Agent active time to six hours', () => {
  expect(loadConfig(environment).harnesses.timeoutMs).toBe(21_600_000)
})

it('validates supported production operator overrides and retains their effective values', () => {
  expect(loadConfig({ ...environment, CODEX_BINARY: '/opt/codex',
    HARNESS_TIMEOUT_MS: '600000', DATABASE_QUERY_TIMEOUT_MS: '2000' }))
    .toMatchObject({ harnesses: { codexBinary: '/opt/codex', timeoutMs: 600000 },
      database: { queryTimeoutMs: 2000 } })
  for (const invalid of [{ HARNESS_TIMEOUT_MS: '-1' }, { HOST: '0.0.0.0' }, { DATABASE_URL: 'postgresql://owner:password@remote/graphql_production' }]) {
    expect(() => loadConfig({ ...environment, ...invalid })).toThrow()
  }
})

it.each(['GRAPHQL_', 'FOREMAN_CODE_'])('keeps local production restrictions with %s settings', prefix => {
  const local = { NODE_ENV: 'production', HOST: '127.0.0.1', DATABASE_URL: environment.DATABASE_URL,
    [`${prefix}LOCAL_PRODUCTION`]: '1' }
  expect(loadConfig(local).host).toBe('127.0.0.1')
  for (const harness of ['codex', 'claude'] as const) {
    expect(new NativeRollout(local).enabled(harness)).toBe(true)
    expect(new NativeRollout({ ...local, HOST: '0.0.0.0' }).enabled(harness)).toBe(false)
    expect(new NativeRollout({ ...local, DATABASE_URL: 'postgresql://owner@remote/database' }).enabled(harness)).toBe(false)
  }
  expect(new NativeRollout({ ...local, [`${prefix}ENABLE_EXPERIMENTAL_CODEX_APP_SERVER`]: '0' }).enabled('codex'))
    .toBe(false)
  expect(() => loadConfig({ ...local, HOST: '0.0.0.0' })).toThrow('loopback')
})

it('accepts matching production aliases and rejects conflicting opt-ins', () => {
  const local = { ...environment, FOREMAN_CODE_LOCAL_PRODUCTION: '1' }
  expect(loadConfig(local).host).toBe('127.0.0.1')
  expect(new NativeRollout(local).enabled('codex')).toBe(true)
  const conflicting = { ...local, FOREMAN_CODE_LOCAL_PRODUCTION: '0' }
  expect(() => loadConfig(conflicting)).toThrow('conflicts')
  expect(() => new NativeRollout(conflicting).enabled('codex')).toThrow('conflicts')
})
