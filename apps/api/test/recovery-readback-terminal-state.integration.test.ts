import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { terminalRecoveryReadback } from './helpers/terminalRecoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('Run recovery readback through HTTP and authenticated MCP', () => {
  it.each(['repeat', 'sequential'] as const)('%s: terminal state, exact results, inputs and version pins survive two API rebuilds without native work', terminalRecoveryReadback, 90000)
})
