import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertCleanupWaitsForOriginalWriter } from './helpers/settlementScenario.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('Run settlement waits for the original cleanup writer', () => {
  it.each(['S3-01', 'S3-05-early'] as const)('%s waits for the original cleanup writer, without driving the engine',
    assertCleanupWaitsForOriginalWriter, 90000)
})
