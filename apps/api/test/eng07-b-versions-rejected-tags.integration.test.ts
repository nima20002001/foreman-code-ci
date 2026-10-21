import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { scenarioFixture } from './helpers/eng07BScenarios.js'
import { scenarioHarness, type Harness } from './helpers/eng07BHarness.js'
import { assertRejectedExecutionTag } from './helpers/workflowVersionAssertions.js'

describe.skipIf(!postgresEnabled)('rejected execution tags over HTTP and MCP', () => {
  let fixture: Harness | undefined

  // Rejections never launch work; each case still saves its own workflow.
  beforeAll(async () => {
    fixture = await scenarioHarness(scenarioFixture('S3-01', randomUUID()))
  }, 90000)

  afterAll(async () => {
    try {
      await fixture?.close()
    } finally {
      vi.restoreAllMocks()
    }
  }, 90000)

  it.each([1, 2, 4, 99])('rejects executionSemanticsVersion=%i explicitly over HTTP and MCP without creating work', async (tag) => {
    await assertRejectedExecutionTag(fixture!, tag)
  }, 90000)
})
