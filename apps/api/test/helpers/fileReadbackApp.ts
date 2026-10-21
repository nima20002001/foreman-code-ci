import type pg from 'pg'
import { afterAll } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { readCurrentRunDetails } from '../../src/modules/runs/currentRead.js'
import { RunInspectionService } from '../../src/modules/runs/inspection.js'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { recordIntegrationStartup } from '../../../../scripts/integration-startup.mjs'
import type { workflowSettlementFixture } from './workflowSettlementFixture.js'

const apps = new Map<pg.Pool, { app: ReturnType<typeof buildApp>; ready: Promise<void> }>()

afterAll(async () => {
  const closing = [...apps.values()]
  apps.clear()
  await Promise.all(closing.map(({ app }) => app.close()))
})

export async function fileReadbackApp(f: Awaited<ReturnType<typeof workflowSettlementFixture>>) {
  const existing = apps.get(f.db.pool)
  if (existing) {
    await existing.ready
    return existing.app
  }
  const started = performance.now()
  const runs: Pick<OperatorServices['runs'], 'get' | 'inspection'> = {
    get: (principal, workspaceId, runId) => readCurrentRunDetails(f.db.pool, principal, workspaceId, runId),
    inspection: new RunInspectionService(f.db.pool),
  }
  // Services read the shared pool; credentials and Run IDs remain per case.
  const app = buildApp({ readiness: { database: { ping: async () => undefined },
    checkpoints: { ping: async () => undefined } }, operator: { access: f.access, services: {
    commands: f.commands,
    runs,
    runGraph: new RunGraphReadService(f.db.pool, { qualifiedReads: true }),
  } as unknown as OperatorServices } })
  const ready = (async () => {
    await app.ready()
    recordIntegrationStartup('readback-app-ready', { setupMs: performance.now() - started })
  })()
  apps.set(f.db.pool, { app, ready })
  await ready
  return app
}
