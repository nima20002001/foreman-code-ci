import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { readDeviceListenerConfig } from '../src/modules/devices/productionConfig.js'
import { resolveLocalBrowserOrigin } from '@foreman-code/contracts/browser-origin'

const database = { DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql' }
describe('renamed configuration boundaries', () => {
  it.each(['GRAPHQL_', 'FOREMAN_CODE_'])('accepts %s while preserving opt-in defaults and installation settings', prefix => {
    const config = loadConfig({ ...database, [`${prefix}LAPTOP_EXECUTION_ENABLED`]: '1' })
    expect(config.workerExecution?.enabled).toBe(true)
    expect(config.database.connectionString).toBe(database.DATABASE_URL)
    expect(config.checkpoints.schema).toBe('langgraph')
    expect(loadConfig(database).workerExecution?.enabled).toBe(false)
    expect(resolveLocalBrowserOrigin({ [`${prefix}WEB_PORT`]: '5198' }).origin).toBe('http://127.0.0.1:5198')
    expect(new NativeRollout({ [`${prefix}ENABLE_EXPERIMENTAL_CODEX_APP_SERVER`]: '0' }).enabled('codex')).toBe(false)
    expect(readDeviceListenerConfig({ [`${prefix}DEVICE_LISTENER_ENABLED`]: '0' }, 3000)).toBeUndefined()
  })

  it('accepts equal dual flags and rejects conflicts without changing security defaults', () => {
    expect(loadConfig({ ...database, FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '0', GRAPHQL_LAPTOP_EXECUTION_ENABLED: '0' }).workerExecution?.enabled).toBe(false)
    expect(() => loadConfig({ ...database, FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1', GRAPHQL_LAPTOP_EXECUTION_ENABLED: '0' })).toThrow('conflicts')
    expect(() => resolveLocalBrowserOrigin({ FOREMAN_CODE_BROWSER_ORIGIN: 'http://localhost:5198', GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5199' })).toThrow('conflicts')
    expect(() => resolveLocalBrowserOrigin({ FOREMAN_CODE_BROWSER_ORIGIN: 'https://example.com' })).toThrow('loopback')
    expect(new NativeRollout({ NODE_ENV: 'production', FOREMAN_CODE_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }).enabled('codex')).toBe(false)
    expect(() => new NativeRollout({ FOREMAN_CODE_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1', GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0' }).enabled('codex')).toThrow('conflicts')
    expect(() => readDeviceListenerConfig({ FOREMAN_CODE_DEVICE_LISTENER_ENABLED: '1', GRAPHQL_DEVICE_LISTENER_ENABLED: '0' }, 3000)).toThrow('conflicts')
  })
})
