import { describe, expect, it } from 'vitest'
import { RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import { runStartSemantics } from '../src/modules/runs/repeatStartDispatch.js'
import { startFixture } from './eng04-start-fixtures.js'

describe('semantics-3 Start discrimination', () => {
  it('accepts explicit semantics 3 as the one current Start family', () => {
    expect(runStartSemantics({ executionSemanticsVersion: 3 })).toBe(3)
  })

  it.each([undefined, 1, 2, null, 0, -1, 4, 99, 2.5, '2', '3', true, {}, []])(
    'rejects retired or unsupported semantics %j instead of selecting another engine',
    (value) => {
      expect(() => runStartSemantics({ executionSemanticsVersion: value })).toThrowError(
        expect.objectContaining({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' }))
    },
  )

  it('requires full displayed revision/configuration/version/location and paired draft pins', () => {
    const f = startFixture()
    expect(RunStartV3InputSchema.parse(f.request)).toEqual(f.request)
    for (const field of ['expectedWorkflowRevision', 'expectedAgentConfigurationVersionIds', 'workflowVersionId',
      'expectedLocationRevision', 'executionSemanticsVersion']) {
      const incomplete: Record<string, unknown> = { ...f.request }; delete incomplete[field]
      expect(RunStartV3InputSchema.safeParse(incomplete).success).toBe(false)
    }
    const { commandId, ...withoutCommand } = f.request
    expect(RunStartV3InputSchema.parse(withoutCommand).commandId).toMatch(/^[0-9a-f-]{36}$/)
    expect(RunStartV3InputSchema.parse(f.request).commandId).toBe(commandId)
    expect(RunStartV3InputSchema.safeParse({ ...f.request, draftId: 'draft-test' }).success).toBe(false)
    expect(RunStartV3InputSchema.safeParse({ ...f.request, expectedDraftRevision: 1 }).success).toBe(false)
    expect(RunStartV3InputSchema.safeParse({ ...f.request, runtimeReady: true }).success).toBe(false)
  })
})
