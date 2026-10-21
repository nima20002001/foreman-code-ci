import { useHarnessSessionEpoch } from '../shared/api/harnessSettings'
import { useMutation } from '@tanstack/react-query'
import { Button } from '../shared/ui/nocturne'
import { sessionGeneration } from '../shared/api/sessionBoundary'
import { useBrowserRecovery } from './browserRecovery'

export function BrowserRecovery() {
  useHarnessSessionEpoch()
  const pending = useBrowserRecovery(state => state.pending)
  const mutation = useMutation({ mutationFn: (item: ReturnType<typeof useBrowserRecovery.getState>['pending'][number]) => item.retry(), retry: false })
  return <>{pending.filter(item => item.generation === sessionGeneration()).map(item => <div role="alert" key={item.id}>
    <p>{item.message}</p><Button disabled={mutation.isPending} onClick={() => mutation.mutate(item)}>Retry browser cleanup</Button>
  </div>)}{mutation.error ? <p role="alert">{mutation.error.message}</p> : null}</>
}
