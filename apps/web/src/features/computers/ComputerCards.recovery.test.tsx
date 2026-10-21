import { act, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import { buildComputerKeys } from '../../shared/api/buildComputers'
import { ComputerCards } from './ComputerCards'
import { computersFixture, mainTarget } from './computersTestFixture'

it.each(['setup-required', 'unavailable'] as const)(
  'updates Main readiness after recovery from %s through server readback', async initial => {
    let state: typeof initial | 'ready' = initial
    const ready: BuildComputerStatus = {
      preference: { target: mainTarget, revision: 8, buildEnabled: true, buildPriority: 100,
        buildAllowancePercent: 60 },
      state: 'ready', reasons: [], remoteExecutionEnabled: true,
    }
    const { client } = computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[]} />, [
      http.post('*/api/management/settings/build-computers/read', () => {
        if (state === 'unavailable') {
          return HttpResponse.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Main is restarting.' } },
            { status: 503 })
        }
        return HttpResponse.json(state === 'ready' ? ready : {
          ...ready, state: 'setup-required', reasons: ['Runtime qualification is pending.'],
          remoteExecutionEnabled: false,
        })
      }),
    ])
    const card = await screen.findByRole('article', { name: 'Main PC' })
    if (initial === 'setup-required') {
      expect(await within(card).findByText('Setup needed')).toBeVisible()
      expect(within(card).getByText('Worker execution').nextElementSibling).toHaveTextContent('Off')
    } else {
      expect(await within(card).findByText('Unavailable')).toBeVisible()
      expect(within(card).queryByText('Worker execution')).not.toBeInTheDocument()
    }
    state = 'ready'
    await act(async () => { await client.invalidateQueries({ queryKey: buildComputerKeys.root }) })
    await waitFor(() => {
      expect(within(card).getByText('Worker execution').nextElementSibling).toHaveTextContent('On')
    })
    expect(within(card).getByText('1st of 1 · up to 60% CPU and RAM')).toBeVisible()
    expect(within(card).queryByText('Setup needed')).not.toBeInTheDocument()
    expect(within(card).queryByText('Unavailable')).not.toBeInTheDocument()
  },
)
