import { beforeEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { CurrentRunProductionBinding } from '../src/modules/runs/currentProduction.js'
import type { RepeatStartPublication } from '../src/modules/runs/repeatStartAdmission.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { createScheduleDispatcher } from '../src/modules/schedules/runtime.js'
import type { PostgresScheduleDispatcher } from '../src/modules/schedules/postgresDispatcher.js'
import { startFixture } from './eng04-start-fixtures.js'

const hooks = vi.hoisted(() => ({ admit: vi.fn(), scheduled: undefined as
  ConstructorParameters<typeof PostgresScheduleDispatcher>[1] | undefined }))
vi.mock('../src/modules/runs/repeatStartAdmission.js', () => ({ admitRepeatRun: hooks.admit }))
vi.mock('../src/modules/schedules/postgresDispatcher.js', () => ({
  PostgresScheduleDispatcher: class {
    constructor(_pool: unknown, start: ConstructorParameters<typeof PostgresScheduleDispatcher>[1]) {
      hooks.scheduled = start
    }
  },
}))
beforeEach(() => { vi.resetAllMocks(); hooks.scheduled = undefined })

// Stop at admission: these controller tests do not manufacture a successful Run.
it.each([
  { transport: 'http', enabled: true }, { transport: 'mcp', enabled: true },
  { transport: 'http', enabled: false }, { transport: 'schedule', enabled: true },
  { transport: 'schedule', enabled: false },
] as const)('preserves the $enabled Worker policy through $transport Start', async ({ transport, enabled }) => {
  const f = startFixture()
  const policy = new WorkerExecutionPolicy({ enabled, managedBy: 'startup' })
  const initializeLocked = vi.fn()
  const production = { startPublication: { workerExecution: policy, initializeLocked },
    assertStartReady: vi.fn(), availability: () => ({ runtimeAdmission: true, stopAvailable: true }) } as unknown as CurrentRunProductionBinding
  const pool = {} as pg.Pool
  const locations = {} as WorkspaceLocationService
  const engine = { start: vi.fn() } as unknown as LangGraphWorkflowEngine
  hooks.admit.mockImplementation(async (_pool, _locations, _principal, _source, _input, publication: RepeatStartPublication) => {
    expect(publication.workerExecution).toBe(policy)
    publication.workerExecution!.requireEnabled({ kind: 'device' })
    throw new Error('Reached the original admission boundary')
  })
  let call: Promise<unknown>
  if (transport === 'schedule') {
    createScheduleDispatcher(pool, locations, production, engine, vi.fn())
    call = hooks.scheduled!(f.principal, f.request,
      {} as Parameters<NonNullable<typeof hooks.scheduled>>[2])
  } else {
    type Dependencies = ConstructorParameters<typeof RunManagementService>
    const service = new RunManagementService(pool, {} as Dependencies[1], {} as Dependencies[2], engine, locations, production)
    call = service.start(f.principal, transport, f.request)
  }
  if (enabled) await expect(call).rejects.toThrow('Reached the original admission boundary')
  else await expect(call).rejects.toMatchObject({ code: 'WORKER_EXECUTION_DISABLED' })
  expect(initializeLocked).not.toHaveBeenCalled()
  expect(engine.start).not.toHaveBeenCalled()
})
