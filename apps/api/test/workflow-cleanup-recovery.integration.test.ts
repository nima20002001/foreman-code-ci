import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RunRecordDetailSchema } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { runPath, scenarioHarness } from './helpers/eng07BHarness.js'
import { scenarioFixture } from './helpers/eng07BScenarios.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('accepted workflow cleanup recovery', () => {
  it('recovers the saved Run after repeated close uncertainty without starting another native turn', async () => {
    const scenario = scenarioFixture('S3-01', randomUUID())
    const f = await scenarioHarness(scenario)
    let closes = 0
    f.base.provider.beforeClose = async () => {
      closes += 1
      if (closes <= 4) {
        throw new DomainError('REPEAT_CLEANUP_PENDING', 'The provider close is not yet confirmed.', 409)
      }
    }
    try {
      const { saved } = await f.save('http')
      const started = await f.start('mcp', saved)
      const record = await f.settled(started.scope)
      expect(record.run).toMatchObject({ id: started.scope.runId, executionState: 'completed', outcome: 'succeeded' })
      const readback = RunRecordDetailSchema.parse(await f.readParity(
        `${runPath(started.scope)}/record`, 'run_record_get', {
          workspaceId: started.scope.workspaceId, runId: started.scope.runId,
        },
      ))
      expect(readback).toEqual(record)
      expect(readback.run.workflowVersionId).toBe(saved.currentVersionId)
      expect(readback.cleanupPending).toBe(false)
      expect(f.base.provider.startedExecutions).toHaveLength(scenario.executedIndexes.length)
      expect(new Set(f.base.provider.startedExecutions).size).toBe(scenario.executedIndexes.length)
      expect(closes).toBeGreaterThan(4)
    } finally {
      delete f.base.provider.beforeClose
      await f.close()
    }
  }, 60_000)
})
