import { Button } from '../../shared/ui/nocturne'

export function HistoryWindowNotice({ onReload, pending }: { onReload(): void; pending: boolean }) {
  return <p role="status" aria-label="History window">
    Only part of earlier history is shown.{' '}
    <Button size="sm" variant="ghost" disabled={pending} onClick={onReload}>Reload nearer history</Button>
  </p>
}
