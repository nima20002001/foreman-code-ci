import { Badge, Tooltip } from '../../shared/ui/nocturne'
import type { StatusChip } from './statusChips'
import './computerStatusChips.css'

export function ComputerStatusChips({ chips, computer, onSignIn }: {
  chips: StatusChip[]; computer: string; onSignIn(tool: string): void
}) {
  return <ul className="computer-status-chips" aria-label={`Status of ${computer}`}>
    {chips.map(chip => <li key={chip.id}>
      <Tooltip content={chip.detail}>
        <span className="computer-status-chip" tabIndex={0} role="img" data-state={chip.state} data-chip={chip.id}
          aria-label={`${chip.label}: ${chip.text}`}>
          <Badge tone={chip.tone} dot={chip.state !== 'running'}>
            {chip.state === 'running' ? <span className="n-spinner n-spinner--small" aria-hidden="true" /> : null}
            {chip.label} · {chip.text}
          </Badge>
        </span>
      </Tooltip>
      {chip.signIn ? <button type="button" className="computer-status-signin" aria-label={`Sign in to ${chip.signIn}`}
        onClick={() => onSignIn(chip.signIn!)}>Sign in</button> : null}
    </li>)}
  </ul>
}
