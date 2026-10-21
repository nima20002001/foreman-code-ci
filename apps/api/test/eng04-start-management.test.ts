import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunManagementService } from '../src/modules/runs/management.js'
import { startFixture } from './eng04-start-fixtures.js'

// Negative service-boundary units only. Positive Start evidence belongs to the
// real production publisher/runtime and NIM-2649 live gate; this file never
// substitutes a mocked admission result for a successful current V3 Start.
const hooks = vi.hoisted(() => ({ current: vi.fn() }))
vi.mock('../src/modules/runs/repeatStartAdmission.js', () => ({ admitRepeatRun: hooks.current }))
beforeEach(() => { vi.resetAllMocks() })

function service() {
  const start = vi.fn(async () => undefined), execute = vi.fn()
  type Dependencies = ConstructorParameters<typeof RunManagementService>
  const values = [{}, { execute }, {}, { start }, {}] as unknown as Dependencies
  return { start, execute, values, service: new RunManagementService(...values) }
}

describe('ENG04-D current V3 RunManagement negative boundaries', () => {
  it('denied V3 Start cannot reach current admission or runtime', async () => {
    const f = startFixture(), s = service()
    await expect(s.service.start({ ...f.principal, grants: [] }, 'http', f.request)).rejects.toThrow()
    expect(hooks.current).not.toHaveBeenCalled()
    expect(s.execute).not.toHaveBeenCalled()
    expect(s.start).not.toHaveBeenCalled()
  })

  it('malformed or unknown V3 input cannot reach current admission or runtime', async () => {
    const f = startFixture(), s = service()
    const stringTag = { ...f.request, executionSemanticsVersion: '3' } as unknown as Parameters<RunManagementService['start']>[2]
    await expect(s.service.start(f.principal, 'http', stringTag)).rejects.toMatchObject({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })

    const incomplete = { ...f.request } as Record<string, unknown>
    delete incomplete.expectedWorkflowRevision
    await expect(s.service.start(f.principal, 'mcp', incomplete as Parameters<RunManagementService['start']>[2])).rejects.toThrow()

    expect(hooks.current).not.toHaveBeenCalled()
    expect(s.execute).not.toHaveBeenCalled()
    expect(s.start).not.toHaveBeenCalled()
  })
})
