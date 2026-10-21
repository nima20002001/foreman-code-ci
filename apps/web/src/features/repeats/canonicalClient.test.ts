import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { RepeatGraphCurrentV3Schema } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { boardV3Fixture, emptyBoardRepeatState } from '../workflow-board/v3Fixture.testSupport'
import { assertRepeatCurrentProgress, createRepeatGraphClient, repeatCurrentPath } from './canonicalClient'

const handler = (fixture: ReturnType<typeof boardV3Fixture>, value: unknown) => http.get(repeatCurrentPath(fixture.scope).split('?')[0]!, ({ request }) => {
  const query = new URL(request.url).searchParams
  expect(query.get('executionSemanticsVersion')).toBe('3')
  expect(query.get('workflowVersionId')).toBe(fixture.scope.workflowVersionId)
  return new HttpResponse(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
})

describe('real shared-schema canonical v3 HTTP reads', () => {
  it('encodes immutable scope and parses a complete canonical current cut', async () => {
    const fixture = boardV3Fixture()
    server.use(handler(fixture, fixture.current))
    expect(await createRepeatGraphClient().current(fixture.scope)).toEqual(fixture.current)
  })
  it('rejects an empty, schema-valid response for a moving workflow version', async () => {
    const fixture = boardV3Fixture()
    const wrong = RepeatGraphCurrentV3Schema.parse({ ...fixture.current,
      scope: { ...fixture.scope, workflowVersionId: 'moving-head' }, state: emptyBoardRepeatState() })
    server.use(handler(fixture, wrong))
    await expect(createRepeatGraphClient().current(fixture.scope)).rejects.toThrow(/selected immutable Run\/version/)
  })
  it('does not accept an unqualified, legacy or partial response as v3 current', async () => {
    const fixture = boardV3Fixture()
    server.use(handler(fixture, { ...fixture.current, kind: 'snapshot', scope: { ...fixture.scope, executionSemanticsVersion: 3 } }))
    await expect(createRepeatGraphClient().current(fixture.scope)).rejects.toThrow()
  })
  it('rejects a regressed cut and changed facts at the same sequence', () => {
    const { current } = boardV3Fixture()
    expect(() => assertRepeatCurrentProgress(current, { ...current, asOfSequence: '2' })).toThrow(/regressed/)
    expect(() => assertRepeatCurrentProgress(current, { ...current, state: { ...current.state,
      run: { ...current.state.run, stopRequested: true } } })).toThrow(/regressed/)
    expect(() => assertRepeatCurrentProgress(current, { ...current, asOfSequence: '4' })).not.toThrow()
  })
})
