import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HttpResponse } from 'msw'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, RespondToInteractionRequestSchema } from '@foreman-code/contracts'
import { LocalHumanAccessSchema, ManagementActionSchema } from '@foreman-code/contracts/management'
import { CurrentRunDetailsSchema, RepeatGraphCurrentV3Schema, RunExecutionDetailSchema } from '@foreman-code/contracts/wave25'
import { boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, openRunDetails } from './eng05D.testSupport'
import { eng07BoardFixture } from './eng07B.testSupport'

installBoardTestLifecycle()

describe('ENG07-B S3-04 human approval on the mounted ordinary Board', () => {
  it('sends the exact offered response and waits for server completion rather than inventing a repeat or native acknowledgement', async () => {
    const f = await eng07BoardFixture('S3-04', 'eng07-human-board'), user = userEvent.setup()
    const requester = f.at(1, 1).detail.execution, terminalCurrent = f.mock.currents.get(f.run.id)!
    const { result: _result, finishedAt: _finished, ...unfinished } = f.run
    void _result; void _finished
    f.mock.runs.set(f.run.id, CurrentRunDetailsSchema.parse({ ...f.record,
      run: { ...unfinished, executionState: 'waiting', outcome: 'pending' } }))
    const { finishedAt: _metadataFinished, ...metadata } = f.rows[0]!.detail.run
    void _metadataFinished
    f.mock.inspection.set(f.run.id, f.rows.slice(0, 2).map((row, index) => {
      const { reportedResult: _reported, ...detail } = row.detail
      const { finishedAt: _executionFinished, ...execution } = detail.execution
      void _reported; void _executionFinished
      return { ...row, detail: RunExecutionDetailSchema.parse({ ...(index === 1 ? detail : row.detail),
        run: { ...metadata, executionState: 'waiting', outcome: 'pending' }, ...(index === 1 ? {
          execution: { ...execution, state: 'waiting', acceptedResultAvailable: false },
          acceptedResult: { status: 'not_accepted' },
        } : {}) }) }
    }))
    f.mock.currents.set(f.run.id, RepeatGraphCurrentV3Schema.parse({ ...terminalCurrent, asOfSequence: '1',
      state: { ...terminalCurrent.state, run: { ...terminalCurrent.state.run, executionState: 'waiting', outcome: 'pending', pendingInteractionCount: 1 } } }))
    let interaction = DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex,
      id: `interaction-${f.run.id}`, workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      runId: f.run.id, executionId: requester.executionId, requestingAgentId: nativeNode(requester).agentId,
      revision: 0, approval: { handler: 'user' } })
    const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')!
    const writes: Array<ReturnType<typeof RespondToInteractionRequestSchema.parse>> = []
    let terminalPublished = false
    const wire = measureBoardWire(f.mock, async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/api/local-human') return HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
        id: 'eng07-human', name: 'ENG07 human', expiresAt: '2099-01-01T00:00:00.000Z',
        grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }],
      } }))
      if (request.method === 'GET' && url.pathname === '/api/user/interactions') {
        return HttpResponse.json({ items: terminalPublished ? [] : [interaction], nextCursor: null })
      }
      if (request.method === 'GET' && url.pathname === `/api/user/interactions/${interaction.id}`) {
        return HttpResponse.json({ interaction, canRespond: true })
      }
      if (request.method === 'POST' && url.pathname === `/api/user/interactions/${interaction.id}/respond`) {
        const input = RespondToInteractionRequestSchema.parse(await request.json()); writes.push(input)
        expect(input).toMatchObject({ interactionId: interaction.id, expectedRevision: 0, optionId: option.optionId })
        interaction = DurableInteractionSchema.parse({ ...interaction, revision: 1, status: 'delivery_pending',
          selectedOptionId: option.optionId, selectedSemantic: option.semantic, nativeResponse: { syntheticDecision: option.optionId },
          decidedAt: f.run.createdAt, deliveryState: 'uncertain' })
        return HttpResponse.json({ interaction, replayed: false })
      }
      return undefined
    })
    const mounted = await mountMeasuredBoard(boardHref(f.scope)), inspection = await openRunDetails()
    expect(within(inspection).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Human approvals for this Run'))
    fireEvent.click(await screen.findByText(`Human approval ${interaction.id} · pending`))
    const responses = await screen.findByRole('group', { name: 'Offered human responses' })
    const button = within(responses).getByRole('button', { name: option.label })
    await waitFor(() => expect(button).toBeEnabled()); await user.click(button)
    await screen.findByText(/Human decision recorded\. Approval response is not native acknowledgement\./)
    expect(writes).toHaveLength(1)
    expect(f.mock.runs.get(f.run.id)!.run.executionState).toBe('waiting')
    expect(f.mock.inspection.get(f.run.id)!.find((row) => row.detail.execution.executionId === requester.executionId)!.detail.acceptedResult)
      .toEqual({ status: 'not_accepted' })
    expect(screen.queryByLabelText(`Accepted result ${requester.executionId}`)).not.toBeInTheDocument()
    // Independent server readback, not a local optimistic acknowledgement, now
    // supplies the terminal state and the exact accepted successor history.
    await act(async () => {
      terminalPublished = true
      f.mock.runs.set(f.run.id, f.record); f.mock.inspection.set(f.run.id, f.rows)
      f.mock.currents.set(f.run.id, RepeatGraphCurrentV3Schema.parse({ ...terminalCurrent, asOfSequence: '2' }))
      await mounted.cache.invalidateQueries()
    })
    const last = f.at(2, 1).detail
    await user.click(await within(inspection).findByRole('button', { name: new RegExp(last.execution.executionId) }))
    const article = await screen.findByRole('article', { name: `Execution ${last.execution.executionId}` })
    expect(JSON.parse(within(article).getByLabelText(`Input ${last.execution.executionId}`).textContent!)).toEqual(last.acceptedInput.value)
    expect(JSON.parse(within(article).getByLabelText(`Accepted result ${last.execution.executionId}`).textContent!)).toEqual(last.reportedResult)
    expect(within(inspection).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    expect(wire.samples.some((sample) => sample.path === '/api/user/interactions' && sample.query.get('runId') === f.run.id)).toBe(true)
    expect(wire.writes()).toHaveLength(1); expect(writes).toHaveLength(1)
  }, 20000)
})
