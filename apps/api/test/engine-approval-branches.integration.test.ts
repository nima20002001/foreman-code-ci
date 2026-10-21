import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { executeApprovalBranches } from './helpers/engineProviderCases.js'

/** Actual engine, SQL owners, coordinator, capture and approval services.
 * Only external provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('Current production engine provider wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each([1, 2] as const)('executes %i approval branches through native claims and terminal receipts', async branches => {
    await executeApprovalBranches(branches)
  }, 60000)
})
