import { describe, expect, it } from 'vitest'
import {
  RUN_INSPECTION_TOOLS, RunExecutionDetailSchema, RunExecutionsPageSchema,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  requestScope, reader, parity,
} from './helpers/runInspection.js'

describe.skipIf(!postgresEnabled)('PostgreSQL authenticated Run inspection: waiting', () => {
  it('reports a waiting execution as not accepted, never promotes an unaccepted native report to input', async () => {
    const f = await currentOperatorIntegration()
    try {
      await f.engine.start(f.f.run.id)
      await expect.poll(async () => (await f.runs.get(f.f.run.id))?.executionState, { timeout: 20000 }).toBe('waiting')
      const r = await reader(f), args = requestScope(f)
      const page = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, args))
      const waiting = page.items.find((item) => !item.acceptedResultAvailable)!
      expect(waiting).toBeDefined()
      const detail = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution,
        { ...args, executionId: waiting.executionId }))
      expect(detail.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(detail.execution.acceptedResultAvailable).toBe(false)
      expect(detail.acceptedInput.value.predecessors).toHaveLength(1)
      expect(detail).not.toHaveProperty('reportedResult')
      await f.stop()
    } finally { await f.close() }
  }, 90000)
})
