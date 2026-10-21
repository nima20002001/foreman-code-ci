import { describe, expect, it, vi } from 'vitest'
import { RunStartV3InputSchema, RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { ApiClient } from '../../shared/api/client'
import { createBoardStartClient, parseBoardStart } from './startClient'
import { boardV3Fixture } from './v3Fixture.testSupport'

const requestFor = (fixture: ReturnType<typeof boardV3Fixture>) => RunStartV3InputSchema.parse({ executionSemanticsVersion: 3,
  workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, workflowVersionId: fixture.scope.workflowVersionId,
  expectedWorkflowRevision: 7, expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
  expectedLocationRevision: fixture.run.executionLocation?.locationRevision ?? 0,
  commandId: 'fde92986-fcb2-4d2e-8e6c-0ddc2141efbf', input: fixture.run.input })

describe('real shared Start request/response schema boundary', () => {
  it('keeps all v3 pins and does not attach a v2 draft', () => {
    const request = requestFor(boardV3Fixture())
    expect(parseBoardStart(request)).toEqual(request)
    expect(request).not.toHaveProperty('draftId')
    expect(() => parseBoardStart({ ...request, executionSemanticsVersion: 4 })).toThrow()
    expect(() => parseBoardStart({ ...request, expectedAgentConfigurationVersionIds: undefined })).toThrow()
  })
  it('checks the returned semantics and immutable pins through the actual HTTP client', async () => {
    const fixture = boardV3Fixture(), request = requestFor(fixture)
    const result = RunStartV3ResultSchema.parse({ run: fixture.run, accepted: true, replayed: true })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(result), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const client = createBoardStartClient(new ApiClient({ fetch: fetchImpl }))
    expect((await client.start(request)).run.workflowVersionId).toBe(request.workflowVersionId)
    const init = fetchImpl.mock.calls.at(-1)?.[1]
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual(request)
  })
  it('rejects a schema-valid acknowledgement for another saved version', async () => {
    const fixture = boardV3Fixture(), request = requestFor(fixture)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ run: { ...fixture.run, workflowVersionId: 'another-version' }, accepted: true, replayed: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    await expect(createBoardStartClient(new ApiClient({ fetch: fetchImpl })).start(request)).rejects.toThrow(/retained Start pins/)
  })
})
