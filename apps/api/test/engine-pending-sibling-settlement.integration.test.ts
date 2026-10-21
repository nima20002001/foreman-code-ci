import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { preservePendingSibling } from './helpers/engineProviderCases.js'

/** Actual engine, SQL owners, coordinator, capture and approval services.
 * Only external provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('Current production engine provider wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each(['resume', 'stop'] as const)('preserves the unconsumed sibling while settlement is pending, then %s', async action => {
    await preservePendingSibling(action)
  }, 60000)
})
