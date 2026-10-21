import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const environment = { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/workflow_test' }

it('defaults stuck execution detection to one hour and accepts a configured idle interval', () => {
  expect(loadConfig(environment).stuckExecutionIdleMs).toBe(3_600_000)
  expect(loadConfig({ ...environment, FOREMAN_CODE_STUCK_EXECUTION_IDLE_MS: '7200000' })
    .stuckExecutionIdleMs).toBe(7_200_000)
})

it.each(['0', '-1', '1.5', 'invalid'])('rejects invalid stuck execution idle interval %s', value => {
  expect(() => loadConfig({ ...environment, FOREMAN_CODE_STUCK_EXECUTION_IDLE_MS: value })).toThrow()
})
