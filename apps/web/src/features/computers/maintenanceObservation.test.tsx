import { screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ComputerCards } from './ComputerCards'
import { computerReadHandler, computersFixture, mainId, mainTarget } from './computersTestFixture'

it('shows the maintenance observation error and failed read count on the computer card', async () => {
  computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    computerReadHandler('maintenance', { computers: [{ target: mainTarget, status: null, observation: {
      status: 'unavailable', lastError: 'Maintenance observation failed (DEVICE_TRANSPORT_ERROR).',
      failedAt: '2026-10-14T00:00:01Z', lastSuccess: null, consecutiveFailures: 2,
    } }] }),
  ])
  const card = await screen.findByRole('article', { name: 'Main PC' })
  const alert = await within(card).findByRole('alert')
  expect(alert).toHaveTextContent('DEVICE_TRANSPORT_ERROR')
  expect(alert).toHaveTextContent('2 consecutive failed reads')
  expect(within(card).getByRole('button', { name: 'Retry maintenance' })).toBeVisible()
})
