import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as terminalResolution from '../src/modules/runs/repeatNode.js'
import {
  RUN_INSPECTION_TOOLS, RunExecutionDetailSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  requestScope, reader, allExecutions, parity, terminal, resaveChangingRepeat, denied,
} from './helpers/runInspection.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('PostgreSQL authenticated Run inspection: saved-resolution', () => {
  it('reads an older accepted execution without recomputing its saved routing resolution', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id)
      await terminal(f)
      const r = await reader(f)
      const [execution] = await allExecutions(f, r)
      const args = { ...requestScope(f), executionId: execution!.executionId }
      const before = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, args))
      expect(before.acceptedResult.status).toBe('accepted')
      // Model a terminal algorithm change after immutable results were published.
      const calculate = terminalResolution.repeatTerminalResolution
      vi.spyOn(terminalResolution, 'repeatTerminalResolution').mockImplementation((...input) => {
        const resolution = calculate(...input)
        return { ...resolution, value: { ...resolution.value,
          resolvedAt: new Date(Date.parse(resolution.value.resolvedAt) + 1).toISOString() } }
      })
      const persisted = (await f.db.pool.query('select record from harness_executions where id=$1', [args.executionId])).rows[0]
      await expect(f.runs.getAcceptedResult(args.executionId)).rejects.toMatchObject({ code: 'REPEAT_INPUT_NOT_ACCEPTED' })
      await resaveChangingRepeat(f)
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, args)).toEqual(before)
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, args)).toEqual(before)
      const forbidden = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }])
      await denied(f, forbidden.client, forbidden.token, RUN_INSPECTION_TOOLS.execution, args, 403, 'ACCESS_DENIED')
      expect((await f.db.pool.query('select record from harness_executions where id=$1', [args.executionId])).rows[0])
        .toEqual(persisted)
    } finally {
      await f.close()
    }
  }, 90000)
})
