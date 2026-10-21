import type { AgentHarness } from '@foreman-code/contracts'
import { useQuery } from '@tanstack/react-query'
import { Button } from '../../shared/ui/nocturne'
import { ChatNotice } from '../conversations/ChatNotice'
import { getExecutionReadiness } from './executionReadiness'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'

export function ExecutionReadinessNotice({ harness, configurationVersionId }: { harness: AgentHarness; configurationVersionId?: string }) {
  const epoch = useHarnessSessionEpoch()
  const query = useQuery({ queryKey: ['workbench', 'management', 'operator-readiness', epoch, harness, configurationVersionId],
    enabled: !sessionIsSwitching(), queryFn: ({ signal }) => getExecutionReadiness(harness, signal, 'operator-configuration', configurationVersionId),
    retry: false, staleTime: 30_000 })
  if (query.isPending) return null
  const check = <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Check again</Button>
  if (query.isError) return <ChatNotice title="Execution eligibility is unverified" action={check}>
    MCP installation alone does not confirm that agents can run. You can continue browsing.
  </ChatNotice>
  const result = query.data
  if (result.status === 'eligible') return null
  return <ChatNotice title={result.status === 'unverified' ? 'Execution eligibility is unverified' : 'Execution is unavailable'} action={check}>
    {result.reason?.message}
  </ChatNotice>
}
