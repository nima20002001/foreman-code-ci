import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { RunStartV3Input } from '@foreman-code/contracts/wave25'
import { RunManagementService } from '../src/modules/runs/management.js'

// This is a negative service-boundary guard, not an old-version fixture or a
// compatibility prerequisite. No database/runtime method may be reached.
describe('ENG05-D explicit unsupported-semantics guard', () => {
  it('returns EXECUTION_SEMANTICS_UNSUPPORTED before admission, provider dispatch or any fallback read', async () => {
    const touched = vi.fn(() => { throw new Error('Unsupported semantics reached a dependency') })
    const dependency = new Proxy({}, { get: touched })
    const args = [dependency, dependency, dependency, dependency, dependency] as unknown as ConstructorParameters<typeof RunManagementService>
    const service = new RunManagementService(...args)
    const principal: ManagementPrincipal = { id: 'eng05d-reader', name: 'ENG05-D', audience: 'operator',
      grants: [], revokedAt: null, expiresAt: '2099-01-01T00:00:00.000Z' }
    // Deliberately untrusted transport input. A cast does not parse/convert it.
    const input = { executionSemanticsVersion: 99 } as unknown as RunStartV3Input
    await expect(service.start(principal, 'http', input)).rejects.toMatchObject({
      code: 'EXECUTION_SEMANTICS_UNSUPPORTED', status: 409,
    })
    expect(touched).not.toHaveBeenCalled()
  })
})
