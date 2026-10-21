import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { agentProductRoleLabel, type AgentIdentity, type ExecutionRef, type HierarchyReport, type WorkflowHierarchyReadInput } from '@foreman-code/contracts'
import { Alert, Button } from '../../shared/ui/nocturne'
import { hierarchyKey, useHierarchy, useHierarchyReports, refreshHierarchyReports } from './queries'
import { subscribeHierarchy } from './stream'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { MasterRunState } from './MasterRunState'
import { ReportDetail } from './ReportDetail'
import { HierarchyReportHistory } from './HierarchyReportHistory'
import './hierarchy.css'

const reportState = { started: 'Starting', working: 'Working', blocked: 'Blocked', returned: 'Returned', failed: 'Failed', canceled: 'Canceled' }
type Actions = { onChat(nodeId: string, execution?: ExecutionRef): void; onReport(report: HierarchyReport): void
  onExecution(agent: AgentIdentity, execution: ExecutionRef): void; onSettings(nodeId: string): void
  onCard?(cardId: string, report: HierarchyReport): void
  onChooseMaster?(): void; onCurrentWorkflow?(): void; onTeam?(nodeId?: string): void }

function Branch({ scope, parent, members, actions, visible }: { scope: WorkflowHierarchyReadInput; parent: AgentIdentity;
  members: { agent: AgentIdentity; children: AgentIdentity[] }[]; actions: Actions; visible: boolean }) {
  const reports = useHierarchyReports(scope, parent.workflowNodeId, visible && !!scope.runId)
  const denied = useProtectedAccessError(reports)
  const [expanded, setExpanded] = useState<string[]>([])
  const [selectedReport, setSelectedReport] = useState<HierarchyReport>()
  const [historyAgent, setHistoryAgent] = useState<AgentIdentity>()
  const latest = new Map(reports.data?.pages.flatMap(page => page.items).map(report => [report.agent.workflowNodeId, report]))
  const missingReport = !reports.data ? reports.isLoading || reports.isFetching ? 'Loading report…' : 'Reports unavailable'
    : reports.hasNextPage ? 'Report not loaded' : reports.isSuccess ? 'No reports yet' : 'No report in the last known update'
  if (denied) return <Alert tone="warning" title="Reports are no longer available with your access.">
    <Button size="sm" onClick={() => void reports.refetch()}>Retry</Button></Alert>
  return <section aria-label={`Reports to ${parent.displayName}`}>
    {reports.isLoading && scope.runId ? <p role="status">Loading reports…</p> : null}
    {reports.error ? <Alert tone="warning" title="Couldn’t refresh reports.">Last known reports stay visible.
      {reports.dataUpdatedAt ? <p>Last updated <time dateTime={new Date(reports.dataUpdatedAt).toISOString()}>{new Date(reports.dataUpdatedAt).toLocaleString()}</time></p> : null}
      <Button size="sm" onClick={() => void reports.refetch()}>Retry</Button></Alert> : null}
    <ul className="hierarchy-branches">
      {[...members].sort((left, right) => {
        const priority = (agent: AgentIdentity) => ['blocked', 'failed'].includes(latest.get(agent.workflowNodeId)?.state ?? '') ? 0 : 1
        return priority(left.agent) - priority(right.agent)
      }).map(({ agent, children }) => {
        const report = latest.get(agent.workflowNodeId), open = expanded.includes(agent.workflowNodeId)
        return <li key={agent.workflowNodeId}>
          <h3>{agent.displayName} <small>{agentProductRoleLabel(agent.productRole)} · {agent.workflowNodeId}</small></h3>
          <p>{scope.runId ? report ? reportState[report.state] : missingReport : 'No run selected'}</p>
          {report?.summary ? <p>{report.summary}</p> : null}
          {report ? <p>Reported <time dateTime={report.updatedAt}>{new Date(report.updatedAt).toLocaleString()}</time></p> : null}
          <div className="next-draft-inline">
            <Button size="sm" onClick={() => actions.onChat(agent.workflowNodeId)}>Chat</Button>
            <Button size="sm" onClick={() => actions.onSettings(agent.workflowNodeId)}>Settings</Button>
            {report ? <Button size="sm" onClick={() => setSelectedReport(report)}>View report</Button> : null}
            {scope.runId ? <Button size="sm" onClick={() => setHistoryAgent(agent)}>Report history</Button> : null}
            {agent.productRole === 'orchestrator' && actions.onTeam ? <Button size="sm" onClick={() => actions.onTeam?.(agent.workflowNodeId)}>View team</Button> : null}
            {children.length ? <Button size="sm" aria-expanded={open} onClick={() => setExpanded(current => open
              ? current.filter(id => id !== agent.workflowNodeId) : [...current, agent.workflowNodeId])}>
              {open ? 'Hide branch' : `View branch · ${children.length}`}</Button> : null}
          </div>
          {open ? <Branch scope={scope} parent={agent} members={children.map(child => ({ agent: child, children: [] }))}
            actions={actions} visible={visible} /> : null}
        </li>
      })}
    </ul>
    {reports.hasNextPage ? <Button size="sm" disabled={reports.isFetchingNextPage} onClick={() => void reports.fetchNextPage()}>Load more teams</Button> : null}
    <ReportDetail report={visible && selectedReport?.execution.runId === scope.runId ? selectedReport : undefined}
      close={() => setSelectedReport(undefined)} showExecution={actions.onReport} showCard={actions.onCard} />
    {historyAgent && scope.runId ? <HierarchyReportHistory key={`${scope.runId}:${historyAgent.workflowNodeId}`}
      scope={scope} agent={historyAgent} visible={visible} initialReport={latest.get(historyAgent.workflowNodeId)} close={() => setHistoryAgent(undefined)}
      showExecution={actions.onReport} showCard={actions.onCard} /> : null}
  </section>
}

export function MasterOverview({ workspaceId, workflowId, runId, teamNodeId, visible = true, ...actions }: {
  workspaceId: string; workflowId: string; runId?: string | undefined; teamNodeId?: string; visible?: boolean
} & Actions) {
  const scope: WorkflowHierarchyReadInput = { workspaceId, workflowId, ...(runId ? { runId } : {}) }
  const hierarchy = useHierarchy(scope, { enabled: visible }), cache = useQueryClient()
  const denied = useProtectedAccessError(hierarchy)
  const [connected, setConnected] = useState(true)
  const [subscription, retrySubscription] = useState(0)
  const masterId = hierarchy.data?.hierarchy?.masterNodeId
  useEffect(() => {
    if (!visible || !runId || !masterId || denied) return
    const refresh = () => {
      void cache.invalidateQueries({ queryKey: hierarchyKey({ workspaceId, workflowId, runId }), exact: true })
      void refreshHierarchyReports(cache, { workspaceId, workflowId, runId })
    }
    return subscribeHierarchy({ workspaceId, workflowId, runId }, {
      changed: refresh, unavailable: refresh, connection: setConnected,
    })
  }, [workspaceId, workflowId, runId, masterId, cache, denied, subscription, visible])
  if (denied) return <Alert tone="warning" title="Overview is no longer available with your access.">
    <Button onClick={() => void hierarchy.refetch()}>Retry</Button></Alert>
  if (hierarchy.isLoading) return <p role="status">Loading Overview…</p>
  if (hierarchy.error && !hierarchy.data) return <Alert tone="warning" title="Couldn’t load Overview.">
    Your selected Run is still selected. <Button onClick={() => void hierarchy.refetch()}>Retry</Button></Alert>
  const saved = hierarchy.data
  const master = saved?.agents.find(agent => agent.workflowNodeId === masterId)
  const refreshWarning = hierarchy.error ? <Alert tone="warning" title="Couldn’t refresh the hierarchy.">Showing the last known saved hierarchy.
    {hierarchy.dataUpdatedAt ? <p>Last updated <time dateTime={new Date(hierarchy.dataUpdatedAt).toISOString()}>{new Date(hierarchy.dataUpdatedAt).toLocaleString()}</time></p> : null}
    <Button onClick={() => void hierarchy.refetch()}>Retry</Button></Alert> : null
  if (!saved?.hierarchy || !master) return <section>{refreshWarning}<h2>No Master in {runId ? 'this Run' : 'this workflow'}</h2>
    <p>{runId ? 'This Run keeps its original saved hierarchy.' : 'Choose an Orchestrator as Master or create a new Master in the draft.'}</p>
    {runId && actions.onCurrentWorkflow ? <Button onClick={actions.onCurrentWorkflow}>Current workflow</Button>
      : !runId && actions.onChooseMaster ? <Button onClick={actions.onChooseMaster}>Choose Master</Button> : null}</section>
  const childrenOf = (parentId: string) => saved.agents.filter(agent => saved.hierarchy!.parents.some(member =>
    member.parentNodeId === parentId && member.workflowNodeId === agent.workflowNodeId))
  const team = teamNodeId ? childrenOf(master.workflowNodeId).find(agent => agent.workflowNodeId === teamNodeId) : undefined
  return <section className="master-overview" aria-label="Master Overview">
    {refreshWarning}
    <header><h2>{master.displayName} <small>Master</small></h2>
      <p>{runId ? `Selected Run · ${runId}` : 'Current saved workflow · No run selected'}</p>
      <Button onClick={() => saved.run?.coordination?.direction
        ? actions.onChat(master.workflowNodeId, saved.run.coordination.direction.execution)
        : actions.onChat(master.workflowNodeId)}>Ask master</Button>
      <Button variant="ghost" onClick={() => actions.onSettings(master.workflowNodeId)}>Master settings</Button>
    </header>
    <MasterRunState key={runId ?? 'configuration'} saved={saved} master={master}
      onChat={actions.onChat} onExecution={actions.onExecution} />
    {runId && !connected ? <Alert tone="warning" title="Connection lost · showing saved status">
      {hierarchy.dataUpdatedAt ? `Last updated ${new Date(hierarchy.dataUpdatedAt).toLocaleString()}` : 'No successful status read yet.'}
      <Button size="sm" onClick={() => { void refreshHierarchyReports(cache, scope); retrySubscription(value => value + 1) }}>Refresh reports</Button></Alert> : null}
    {teamNodeId ? <section aria-label="Selected team"><h3>{team ? `${team.displayName} · Reports to ${master.displayName}` : 'This team is not in the selected saved workflow.'}</h3>
      <Button size="sm" onClick={() => actions.onTeam?.()}>All teams</Button></section> : null}
    {!teamNodeId || team ? <Branch key={JSON.stringify([runId, team?.workflowNodeId ?? master.workflowNodeId])} scope={scope} parent={team ?? master}
      members={childrenOf(team?.workflowNodeId ?? master.workflowNodeId).map(agent =>
        ({ agent, children: childrenOf(agent.workflowNodeId) }))} actions={actions} visible={visible} /> : null}
  </section>
}
