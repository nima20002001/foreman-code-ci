import { Cloud } from 'lucide-react'
import type { CircleAccountRead, CircleOrganizationRead } from '@foreman-code/contracts/management'
import { useCircleAccountsQuery } from '../../shared/api/circleAccounts'
import { Alert, Badge, Button, Card, LoadingState } from '../../shared/ui/nocturne'

const NUMBER = new Intl.NumberFormat('en-US')
const ROLE_LABELS: Record<CircleOrganizationRead['schedulingRole'], string> = {
  active: 'Active',
  standby: 'Standby',
  exhausted: 'Out of credits',
}

export function CircleCiSummaryCard() {
  const query = useCircleAccountsQuery()
  const accounts = query.data?.value.accounts
  return <section className="circleci-summary" aria-label="CircleCI">
    <Card>
      <header className="circleci-summary-header"><Cloud size={18} aria-hidden="true" /><h2>CircleCI</h2></header>
      {query.isPending && <LoadingState label="Loading CircleCI…" rows={1} />}
      {query.isError && <Alert tone="danger" title="CircleCI accounts could not be read." live
        action={<Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          Retry CircleCI
        </Button>} />}
      {query.isSuccess && <div className="circleci-accounts">
        <AccountSummary role="Primary" account={accounts?.find(account => account.role === 'primary')} />
        <AccountSummary role="Standby" account={accounts?.find(account => account.role === 'standby')} />
      </div>}
      <p className="circleci-summary-note">
        The Operator manages account registration. Local setup supplies the API token.
      </p>
    </Card>
  </section>
}

function AccountSummary({ role, account }: { role: 'Primary' | 'Standby'; account: CircleAccountRead | undefined }) {
  return <section className="circleci-account" aria-label={`${role} CircleCI account`}>
    <header><h3>{role}</h3>
      {account && <Badge tone={account.tokenConfigured ? 'neutral' : 'warning'}>
        {account.tokenConfigured ? 'Configured' : 'Setup needed'}
      </Badge>}
      {account?.tokenConfigured && !account.ready && <Badge tone="warning">Needs attention</Badge>}
    </header>
    {account ? <>
      <p className="circleci-account-label">{account.label}</p>
      {account.reasons.map(reason => <p className="circleci-summary-note" key={reason}>{reason}</p>)}
      {account.orgs.length > 0 ? <ul className="circleci-orgs" aria-label={`${role} organizations`}>
        {account.orgs.map(org => <OrganizationSummary key={`${org.circleAccountId}:${org.account}`} org={org} />)}
      </ul> : <p className="circleci-summary-note">No organization status available.</p>}
    </> : <p className="circleci-summary-note">No {role.toLowerCase()} account registered.</p>}
  </section>
}

function OrganizationSummary({ org }: { org: CircleOrganizationRead }) {
  return <li>
    <div className="circleci-org-heading"><strong>{org.account}</strong>
      <Badge tone={org.schedulingRole === 'exhausted' ? 'warning' : 'neutral'}>
        {ROLE_LABELS[org.schedulingRole]}
      </Badge>
      {!org.ready && <Badge tone="warning">Not ready</Badge>}
    </div>
    <p>{org.running} {org.running === 1 ? 'job' : 'jobs'} running</p>
    {org.credits ? <>
      <p>≈ {NUMBER.format(org.credits.remaining)} credits left</p>
      <p className="circleci-summary-note"><time dateTime={org.credits.asOf}>
        Updated {readingAge(org.credits.asOf)}
      </time></p>
    </> : <p>Credits unavailable</p>}
    {org.creditsUnavailable && <p className="circleci-summary-note">{org.creditsUnavailable}</p>}
    <p className="circleci-summary-note">{org.schedulingReason}</p>
  </li>
}

function readingAge(asOf: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(asOf)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} d ago`
}
