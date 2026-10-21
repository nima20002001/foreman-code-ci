import { expect, it, vi } from 'vitest'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { WorkflowNativeProofServices } from '../src/modules/runs/workflowNativeProof.js'

it('lists recovery IDs without loading snapshots for locally owned or backing-off runs', async () => {
  const rows = [{ id: 'active' }, { id: 'backing-off' }, { id: 'recoverable' }]
  const query = vi.fn(async () => ({ rows }))
  const runs = new PostgresRunRepository({ query } as never, {} as never,
    { revalidateRunAuthorization: vi.fn() } as never, {
      runtimeRoot: '/workspace/runtime', native: new WorkflowNativeProofServices({} as never),
      services: { assertNativeBoundaryLocked: vi.fn(), assertNativeUpdateLocked: vi.fn(),
        assertSettlementLocked: vi.fn(), allowTechnicalRetryLocked: vi.fn(), completeRunLocked: vi.fn() },
    })
  const snapshot = vi.spyOn(runs, 'getRepeatSnapshot').mockImplementation(async id => ({ run: { id } }) as never)

  expect(await runs.reconciliationCandidates('', 100)).toEqual(rows)
  expect(snapshot).not.toHaveBeenCalled()
  expect(query).toHaveBeenCalledTimes(1)
})
