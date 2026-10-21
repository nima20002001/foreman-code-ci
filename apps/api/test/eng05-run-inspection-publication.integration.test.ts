import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { requestWorkflowStopLocked } from '../src/modules/runs/repeatLifecycle.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import {
  RUN_INSPECTION_TOOLS, RunRecordDetailSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  requestScope, reader, parity, denied,
} from './helpers/runInspection.js'

describe.skipIf(!postgresEnabled)('PostgreSQL authenticated Run inspection: publication', () => {
  it('reads committed Run records during a held publication and preserves scoped access and persisted readback', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
    let release!: () => void
    const proceed = new Promise<void>(resolve => { release = resolve })
    let staged!: () => void
    const ready = new Promise<void>(resolve => { staged = resolve })
    const args = requestScope(f)
    const publication = withExclusiveGraphConnection(f.db.pool, connection => connection.transaction(async sql => {
      await requestWorkflowStopLocked(sql, args.runId, async transaction => {
        const live = await readLiveManagementPrincipal(transaction, f.writer.principal.id)
        requireAuthorization(live, 'runs:stop', { ...args, workflowId: f.f.scope.workflowId })
      })
      staged()
      await proceed
    })).then(() => ({ success: true as const }), error => ({ success: false as const, error }))
    let reading: Promise<void> | undefined
    try {
      await Promise.race([ready, publication.then(result => {
        if (!result.success) throw result.error
        throw new Error('Publication finished before its test barrier')
      })])
      const r = await reader(f)
      let result: [unknown, Awaited<ReturnType<typeof f.runs.getRepeatSnapshot>>] | undefined
      let readError: unknown
      reading = Promise.all([
        parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.record, args),
        f.runs.getRepeatSnapshot(args.runId),
      ]).then(value => { result = value }, error => { readError = error })
      await expect.poll(() => Boolean(result || readError), { timeout: 1500 }).toBe(true)
      if (readError) throw readError
      expect(RunRecordDetailSchema.parse(result![0])).toMatchObject({
        run: { executionState: 'queued', workflowVersionId: f.f.run.workflowVersionId },
        stopRequested: false, cleanupPending: false,
      })
      expect(result![1]).toMatchObject({ stopRequested: false, cleanupPending: false })
      const forbidden = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      await denied(f, forbidden.client, forbidden.token, RUN_INSPECTION_TOOLS.record, args, 403, 'ACCESS_DENIED')
      release()
      expect(await publication).toEqual({ success: true })
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.record, args))
        .toMatchObject({ stopRequested: true, cleanupPending: true })
      await f.access.revoke(r.principal.id)
      await expect(f.services.runs.inspection.record(r.principal, args)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally {
      release()
      await publication
      if (reading) await reading
      await f.close()
    }
  }, 90000)
})
