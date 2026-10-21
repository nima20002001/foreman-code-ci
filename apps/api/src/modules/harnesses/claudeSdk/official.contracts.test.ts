import { expect, it } from 'vitest'
import { assertClaudeSdkContract } from './official.js'

const methods = ['query', 'getSessionInfo', 'getSessionMessages', 'forkSession', 'listSubagents', 'getSubagentMessages']
it('accepts any SDK version providing the required exports', () => {
  const sdk = Object.fromEntries(methods.map(method => [method, () => undefined]))
  expect(() => assertClaudeSdkContract(sdk, '0.4.0')).not.toThrow()
})
it('reports the SDK version and missing method', () => {
  const sdk = Object.fromEntries(methods.filter(method => method !== 'forkSession').map(method => [method, () => undefined]))
  expect(() => assertClaudeSdkContract(sdk, '0.4.0')).toThrow('Claude Code SDK 0.4.0')
  expect(() => assertClaudeSdkContract(sdk, '0.4.0')).toThrow('forkSession method contract')
})
