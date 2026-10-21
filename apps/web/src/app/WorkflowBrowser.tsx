import { useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BrowserTargetSelectionSchema, BrowserTargetResultSchema, type BrowserTargetResult } from '@foreman-code/contracts'
import type { WorkflowCollaborationSlots } from '../features/workflow-board/WorkflowSidePanel'
import { useWorkflowBoard } from '../features/workflow-board/context'
import { AgentBrowserPanel } from '../features/agent-browser/AgentBrowserPanel'
import { useBrowserProfiles } from '../features/browser-profiles/queries'
import { apiClient } from '../shared/api/client'
import { Button } from '../shared/ui/nocturne'
import { browserFilesClient } from './browserClients'
import { browserProfileClient, browserSessionClient } from './browserRecovery'
import { browserAuthBoundary, useBrowserComputers } from './browserComputerFacts'

type Selection = Parameters<NonNullable<WorkflowCollaborationSlots['browser']>>[0]
export function WorkflowBrowser(props: Selection) {
  return props.nodeId ? <SelectedWorkflowBrowser key={JSON.stringify([props.workspaceId, props.workflowId, props.runId, props.nodeId])} {...props} nodeId={props.nodeId} />
    : <p>Select an Agent on the Board, then open Browser.</p>
}
function SelectedWorkflowBrowser(props: Selection & { nodeId: string }) {
  const board = useWorkflowBoard(), navigate = useNavigate(), location = useLocation()
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)
  const input = BrowserTargetSelectionSchema.parse({ workspaceId: props.workspaceId, workflowId: props.workflowId,
    workflowNodeId: props.nodeId, runId: props.runId, workflowVersionId: props.workflowVersionId,
    executionId: props.executionId, waitingActivationId: props.waitingActivationId, cursor })
  const query = useQuery({ queryKey: ['browser-target', browserAuthBoundary(), input], retry: false,
    queryFn: ({ signal }) => apiClient.request(`/api/browser/target?${new URLSearchParams({ input: JSON.stringify(input) })}`, BrowserTargetResultSchema, { signal }) })
  const catalog = useBrowserProfiles(browserProfileClient, browserAuthBoundary(), true), facts = useBrowserComputers()
  const update = (sessionId?: string, tabId?: string) => board?.selectSidePanel?.({ ...props, kind: 'browser', sessionId, tabId })
  const pickRun = (runId: string, workflowVersionId: string, executionId?: string, waitingActivationId?: string) => {
    void navigate({ to: location.pathname, search: previous => ({ ...previous, workflowId: props.workflowId,
      runId, workflowVersionId, executionSemanticsVersion: 3, selectedRunId: undefined, boardPanel: 'browser',
      boardNodeId: props.nodeId, boardExecutionId: executionId, boardWaitingActivationId: waitingActivationId,
      browserSessionId: undefined, browserTabId: undefined }) })
  }
  const result = query.data
  return <>
    {query.isPending ? <p role="status">Finding the selected Agent’s browser…</p> : null}
    {query.error ? <p role="alert">{query.error.message}<Button onClick={() => { void query.refetch() }}>Retry</Button></p> : null}
    {result?.kind === 'selected' ? <AgentBrowserPanel visible selection={{
      authBoundary: browserAuthBoundary(), visitKey: JSON.stringify([result.subject, props.sessionId]),
      subject: result.subject, sessionId: props.sessionId ?? null, tabId: props.tabId ?? null,
      enabled: result.browser.enabled, historical: result.historical }} port={browserSessionClient} files={browserFilesClient}
      preparation={result.preparation} computerName={facts.computers.find(computer => computer.id === result.computerId)?.name ?? 'Selected computer'}
      profileName={catalog.data?.profiles.find(profile => profile.id === result.browser.profileId)?.name ?? 'Browser profile'}
      readOnly={result.readOnly} onOpenSettings={() => board?.selectSidePanel?.({ kind: 'agent', nodeId: props.nodeId, tab: 'settings' })}
      onSelectSession={sessionId => update(sessionId)} onSelectTab={tabId => update(props.sessionId, tabId)} onCleanupError={setNotice} /> : null}
    {result?.kind === 'unavailable' ? <p>{result.reason === 'conversation_missing' ? 'Start an Agent chat to open its saved browser.'
      : result.reason === 'consultation_idle' ? 'The coordinator has no active consultation browser.' : 'This Agent browser is unavailable.'}</p> : null}
    {result?.kind === 'choose_target' ? <BrowserTargetChoices result={result} pick={pickRun} page={setCursor} /> : null}
    {notice ? <p role="alert">{notice}</p> : null}
  </>
}
function BrowserTargetChoices({ result, pick, page }: {
  result: Extract<BrowserTargetResult, { kind: 'choose_target' }>
  pick(runId: string, workflowVersionId: string, executionId?: string, waitingActivationId?: string): void
  page(cursor: string): void
}) {
  const selected = result.selection
  if (selected.kind !== 'run_selection_required' && selected.kind !== 'selection_required') return <p>No active browser target is available for this selection.</p>
  return <section aria-label="Choose browser target"><p>Choose the exact Run or Agent execution.</p>
    {selected.kind === 'run_selection_required' ? selected.items.map(item => <Button key={item.runId}
      onClick={() => pick(item.runId, item.workflowVersionId)}>Run {item.runId}</Button>)
      : selected.items.map(item => {
        const target = item.target
        return <Button key={JSON.stringify(target)} onClick={() => target.kind === 'workflow_execution'
          ? pick(target.execution.runId, item.workflowVersionId, target.execution.executionId)
          : pick(target.runId, item.workflowVersionId, undefined, target.waitingActivationId)}>
          {item.agent.displayName} · {item.source} · {item.state}</Button>
      })}
    {selected.hasMore && selected.nextCursor ? <Button onClick={() => page(selected.nextCursor!)}>More browser targets</Button> : null}
  </section>
}
