import { useEffect, useRef, useState } from 'react'
import { UserRound } from 'lucide-react'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { Button } from '../../shared/ui/nocturne'
import { useFloatingSurface } from '../../shared/ui/nocturne/useFloatingSurface'
import { ChatNotice } from '../conversations/ChatNotice'
import { PinnedProviderAccount } from './PinnedProviderAccount'
import { useProviderAccount } from './providerAccountsQueries'
import './providerAccounts.css'

function useAccountSummary(binding?: AcceptedProviderAccountBinding) {
  const query = useProviderAccount(binding?.kind === 'slot' ? binding : undefined)
  const denied = useProtectedAccessError(query)
  const account = query.isError || denied ? undefined : query.data
  if (!binding || binding.kind === 'legacy-profile') return { short: '', problem: undefined }
  const unavailable = !account || Boolean(account.removedAt) || account.status === 'unavailable'
  return {
    short: account?.name ?? binding.accountId,
    problem: !query.isPending && unavailable
      ? `${account?.removedAt ? 'This account was removed from selection.' : 'The original account is unavailable.'} Restore access to its original computer and profile to continue this work.`
      : undefined,
  }
}

/** Compact header chip for the account a chat is saved with. Details open in a floating panel that stays on screen. */
export function ProviderAccountChip({ binding, label = 'Saved account' }: {
  binding?: AcceptedProviderAccountBinding | undefined; label?: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const summary = useAccountSummary(binding)
  useFloatingSurface(open, anchor, surface, 300, 'end')
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !surface.current?.contains(event.target) && !anchor.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  if (!binding || binding.kind === 'legacy-profile') return null
  return <span className="provider-account-chip" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.current?.focus() }
  }}>
    <Button ref={anchor} size="sm" variant="ghost" aria-label="Saved account details" title={`${label}: ${summary.short}`}
      aria-expanded={open} data-problem={summary.problem ? 'true' : undefined} onClick={() => setOpen(value => !value)}>
      <UserRound size={14} aria-hidden="true" /><span aria-hidden="true">{summary.short}</span>
    </Button>
    {open ? <div ref={surface} popover="manual" className="provider-account-popover">
      <PinnedProviderAccount binding={binding} label={label} />
    </div> : null}
  </span>
}

/** Only an account that can no longer be used is a problem worth a notice. */
export function ProviderAccountProblem({ binding }: { binding?: AcceptedProviderAccountBinding | undefined }) {
  const { problem } = useAccountSummary(binding)
  return problem ? <ChatNotice title="Saved account unavailable">{problem}</ChatNotice> : null
}
