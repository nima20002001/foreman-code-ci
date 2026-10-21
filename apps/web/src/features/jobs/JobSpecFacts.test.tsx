import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { JobQueueFacts } from './JobSpecFacts'
import { autoQueueTicket, definition, verificationQueueTicket } from './fixtures'

it('shows the saved job name, verification suite and request identity before acceptance', () => {
  render(<JobQueueFacts ticket={verificationQueueTicket} />)
  expect(screen.getByText(verificationQueueTicket.definition.name)).toBeVisible()
  expect(screen.getByText('Verification suite').nextElementSibling).toHaveTextContent('unit')
  expect(screen.getByText(verificationQueueTicket.id)).toBeVisible()
})

it.each(['accepted', 'terminal'] as const)('shows the original computer for %s tickets with preferred placement', state => {
  const preferred = { kind: 'prefer' as const, hostRef: definition.spec.target.hostRef }
  const ticket = { ...autoQueueTicket, placement: preferred, placementOverride: preferred }
  const view = render(<JobQueueFacts ticket={ticket} />)
  expect(screen.getByText('Preferred computer')).toBeInTheDocument()
  expect(screen.getByText(/Then try eligible computers in build priority order/)).toBeInTheDocument()
  expect(screen.getByText(/Not assigned/)).toBeInTheDocument()
  view.rerender(<JobQueueFacts ticket={{ ...ticket, state, reservationId: ticket.id,
    terminalReason: state === 'terminal' ? 'completed' : null,
    finishedAt: state === 'terminal' ? ticket.enqueuedAt : null,
    selectedComputer: { target: { ...definition.spec.target, labelAtAcceptance: 'Build laptop' },
      rootId: '11111111-1111-4111-8111-111111111111', bindingRevision: 1, profileId: 'profile', profileRevision: 1 } }} />)
  expect(screen.getByText('Accepted computer')).toBeInTheDocument()
  expect(screen.getByText('Build laptop')).toBeInTheDocument()
  expect(screen.getByText('Preferred computer')).toBeInTheDocument()
})
