import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse, type HttpHandler } from 'msw'
import { expect, it } from 'vitest'
import type { CircleOrganizationRead, ManagedCircleAccounts } from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import { computersFixture, mainId } from '../computers/computersTestFixture'
import { ComputerSettings } from './ComputerSettings'

const endpoint = '*/api/management/settings/circle-accounts'

function accountsFixture(): ManagedCircleAccounts {
  const asOf = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
  return {
    revision: 2,
    versionId: 'circle-accounts-fixture',
    value: {
      accounts: [
        { id: 'default', label: 'Build pool', role: 'primary', tokenConfigured: true, ready: true, reasons: [],
          organizations: ['acme-one', 'acme-two', 'acme-three'],
          orgs: ['acme-one', 'acme-two', 'acme-three'].map((account, index): CircleOrganizationRead => ({
            account, circleAccountId: 'default', ready: true, running: index,
            schedulingRole: 'active', schedulingReason: 'Primary capacity is available.',
            credits: { total: 400000, used: 10000 * (index + 1), remaining: 390000 - 10000 * index, asOf },
          })) },
        { id: 'overflow', label: 'Overflow pool', role: 'standby', tokenConfigured: true, ready: true, reasons: [],
          organizations: ['beta-one', 'beta-two', 'beta-three'],
          orgs: ['beta-one', 'beta-two', 'beta-three'].map((account, index): CircleOrganizationRead => ({
            account, circleAccountId: 'overflow', ready: true, running: 0,
            schedulingRole: 'standby', schedulingReason: 'Waiting for primary credit exhaustion.',
            credits: { total: 400000, used: 50000 * (index + 1), remaining: 350000 - 50000 * index, asOf },
          })) },
      ],
    },
  }
}

function mount(accounts: ManagedCircleAccounts, handler?: HttpHandler) {
  return computersFixture(<ComputerSettings />, [
    http.get('*/api/devices/main', () => HttpResponse.json({
      mainId, mainPublicKey: 'fixture-public-key', mainPublicKeyFingerprint: 'a'.repeat(64),
    })),
    http.get('*/api/devices', () => HttpResponse.json({ devices: [] })),
    handler ?? http.get(endpoint, () => HttpResponse.json(accounts)),
  ])
}

function orgRow(owner: string) {
  return within(screen.getByText(owner).closest('li')!)
}

it('adds a read-only CircleCI summary below the computers with six independent org readings', async () => {
  mount(accountsFixture())
  const card = await screen.findByRole('region', { name: 'CircleCI' })
  const primary = await within(card).findByRole('region', { name: 'Primary CircleCI account' })
  const standby = within(card).getByRole('region', { name: 'Standby CircleCI account' })
  expect(within(primary).getByText('Build pool')).toBeVisible()
  expect(within(standby).getByText('Overflow pool')).toBeVisible()
  expect(within(primary).getByText('Configured')).toBeVisible()
  expect(within(standby).getByText('Configured')).toBeVisible()
  expect(within(primary).getAllByRole('listitem')).toHaveLength(3)
  expect(within(standby).getAllByRole('listitem')).toHaveLength(3)
  for (const [owner, remaining] of [
    ['acme-one', '390,000'], ['acme-two', '380,000'], ['acme-three', '370,000'],
    ['beta-one', '350,000'], ['beta-two', '300,000'], ['beta-three', '250,000'],
  ]) {
    expect(orgRow(owner!).getByText(`≈ ${remaining} credits left`)).toBeVisible()
    expect(orgRow(owner!).getByText(/Updated 3 h ago/)).toBeVisible()
  }
  expect(orgRow('acme-two').getByText('1 job running')).toBeVisible()
  expect(orgRow('acme-three').getByText('2 jobs running')).toBeVisible()
  expect(orgRow('beta-one').getByText('Standby')).toBeVisible()
  expect(within(card).getByText(/Operator manages account registration/)).toBeVisible()
  expect(within(card).getByText(/Local setup supplies the API token/)).toBeVisible()
  expect(within(card).queryByRole('textbox')).not.toBeInTheDocument()
  expect(within(card).queryByRole('combobox')).not.toBeInTheDocument()
  expect(within(card).queryByRole('switch')).not.toBeInTheDocument()
  expect(within(card).queryByRole('button')).not.toBeInTheDocument()
  const computers = await screen.findByRole('list', { name: 'Computers' })
  expect(computers.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('shows setup-needed and the absence of a registered standby without credential controls', async () => {
  const accounts = accountsFixture()
  accounts.value.accounts.splice(1)
  const primary = accounts.value.accounts[0]!
  primary.tokenConfigured = false
  primary.ready = false
  primary.reasons = ['API token setup is required.']
  primary.orgs = []
  mount(accounts)
  const card = within(await screen.findByRole('region', { name: 'CircleCI' }))
  expect(await card.findByText('Setup needed')).toBeVisible()
  expect(card.getByText('API token setup is required.')).toBeVisible()
  expect(card.getByText('No standby account registered.')).toBeVisible()
  expect(card.queryByRole('textbox')).not.toBeInTheDocument()
})

it('keeps configured credentials distinct from an account that needs attention', async () => {
  const accounts = accountsFixture()
  accounts.value.accounts[1]!.ready = false
  accounts.value.accounts[1]!.reasons = ['Account authentication is unavailable.']
  mount(accounts)
  const card = within(await screen.findByRole('region', { name: 'Standby CircleCI account' }))
  expect(card.getByText('Configured')).toBeVisible()
  expect(card.getByText('Needs attention')).toBeVisible()
  expect(card.getByText('Account authentication is unavailable.')).toBeVisible()
})

it('shows loading while the account read is pending', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  mount(accountsFixture(), http.get(endpoint, async () => {
    await pending
    return HttpResponse.json(accountsFixture())
  }))
  try {
    expect(await screen.findByText('Loading CircleCI…')).toBeInTheDocument()
  } finally {
    release()
  }
  expect(await screen.findByText('Build pool')).toBeVisible()
})

it('retries a failed read without exposing provider diagnostics', async () => {
  const accounts = accountsFixture()
  let requests = 0
  mount(accounts, http.get(endpoint, () => {
    requests += 1
    if (requests === 1) return HttpResponse.json({
      error: { code: 'UNAVAILABLE', message: 'private-provider-diagnostic' },
    }, { status: 503 })
    return HttpResponse.json(accounts)
  }))
  expect(await screen.findByText('CircleCI accounts could not be read.')).toBeVisible()
  expect(screen.queryByText(/private-provider-diagnostic/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Retry CircleCI' }))
  expect(await screen.findByText('Build pool')).toBeVisible()
  expect(requests).toBe(2)
})

it('shows unavailable credits and their reason without turning standby into a login failure', async () => {
  const accounts = accountsFixture()
  accounts.value.accounts[0]!.orgs[0]!.credits = null
  accounts.value.accounts[0]!.orgs[0]!.creditsUnavailable = 'Usage reading is stale.'
  accounts.value.accounts[1]!.orgs[0]!.credits = null
  accounts.value.accounts[1]!.orgs[0]!.creditsUnavailable = 'Usage export is unavailable.'
  mount(accounts)
  await screen.findByText('Build pool')
  expect(orgRow('acme-one').getByText('Credits unavailable')).toBeVisible()
  expect(orgRow('acme-one').getByText('Usage reading is stale.')).toBeVisible()
  expect(orgRow('beta-one').getByText('Credits unavailable')).toBeVisible()
  expect(orgRow('beta-one').getByText('Standby')).toBeVisible()
  expect(screen.queryByText(/Not logged in/)).not.toBeInTheDocument()
})

it('reflects server overflow and monthly reset roles without calculating them from credits', async () => {
  const accounts = accountsFixture()
  const primary = accounts.value.accounts[0]!.orgs[0]!
  const replacement = accounts.value.accounts[1]!.orgs[0]!
  primary.schedulingRole = 'exhausted'
  primary.schedulingReason = 'Estimated credits are at the 20,000 reserve.'
  primary.credits = { total: 400000, used: 380000, remaining: 20000, asOf: new Date().toISOString() }
  primary.running = 1
  replacement.schedulingRole = 'active'
  replacement.schedulingReason = 'Replacing primary credit capacity.'
  const f = mount(accounts)
  await screen.findByText('Build pool')
  expect(orgRow('acme-one').getByText('Out of credits')).toBeVisible()
  expect(orgRow('acme-one').getByText(primary.schedulingReason)).toBeVisible()
  expect(orgRow('acme-one').getByText('1 job running')).toBeVisible()
  expect(orgRow('beta-one').getByText('Active')).toBeVisible()
  primary.schedulingRole = 'active'
  primary.schedulingReason = 'New UTC month; primary capacity resumed.'
  primary.credits = null
  primary.creditsUnavailable = 'Waiting for this month’s usage.'
  replacement.schedulingRole = 'standby'
  replacement.schedulingReason = 'Primary capacity resumed.'
  replacement.running = 1
  server.use(http.get(endpoint, () => HttpResponse.json(accounts)))
  await act(() => f.client.invalidateQueries({ queryKey: ['circle-accounts'] }))
  expect(orgRow('acme-one').getByText('Active')).toBeVisible()
  expect(orgRow('acme-one').getByText('Credits unavailable')).toBeVisible()
  expect(orgRow('beta-one').getByText('Standby')).toBeVisible()
  expect(orgRow('beta-one').getByText('1 job running')).toBeVisible()
})
