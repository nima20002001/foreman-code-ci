import { useLinkProps, useLocation, useRouter } from '@tanstack/react-router'
import { useContext } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { cachedWorkflowName, cachedWorkspaceName, useManagedWorkflowQuery, useManagedWorkspaceQuery } from '../api/query'
import { useAccessFailureLatch } from '../api/useAccessFailureLatch'
import { harnessNames, harnessSections, rolePresentation } from '../../features/settings/settingsPresentation'
import { AppNavigationHistoryContext } from './appNavigationHistoryContext'
import './appNavigationTrail.css'

/** pending: the label is a placeholder while the name loads; it keeps a stable width instead of swapping words. */
type Crumb = { label: string; to: string; search?: Record<string, unknown>; pending?: boolean }
const sectionNames: Record<string, string> = {
  workflows: 'Workflows', settings: 'Settings', files: 'Project files', agents: 'Agents',
  tasks: 'Tasks', runs: 'Runs', terminal: 'Terminal', approvals: 'Approvals', location: 'Location',
  harnesses: 'Harnesses', computers: 'Computers', skills: 'Skills', workspaces: 'Workspaces', general: 'General',
  bugs: 'Bugs',
  'system-prompt': 'System prompt',
}

function BreadcrumbLink({ crumb }: { crumb: Crumb }) {
  const props = useLinkProps({ to: crumb.to, search: crumb.search ?? {} })
  // Router links mark matching ancestors active; only the final breadcrumb is the current page.
  return <a {...props} aria-current={undefined} aria-label={`Go to ${crumb.label}`} title={crumb.label}
    className={[props.className, crumb.pending ? 'is-pending' : undefined].filter(Boolean).join(' ') || undefined}>{crumb.label}</a>
}

export function AppNavigationTrail({ activeWorkflowId }: { activeWorkflowId?: string }) {
  const location = useLocation()
  const router = useRouter()
  const canGoBack = useContext(AppNavigationHistoryContext)
  const segments = location.pathname.split('/').filter(Boolean)
  const workspaceId = segments[0] === 'workspaces' ? decodeURIComponent(segments[1] ?? '') : ''
  const workflowId = segments[2] === 'workflows' && segments[3] ? decodeURIComponent(segments[3]) : activeWorkflowId ?? ''
  const workspace = useManagedWorkspaceQuery(workspaceId, Boolean(workspaceId))
  const workflow = useManagedWorkflowQuery(workspaceId, workflowId, Boolean(workspaceId && workflowId))
  const workspaceDenied = useAccessFailureLatch(workspace)
  const workflowDenied = useAccessFailureLatch(workflow)
  const client = useQueryClient()
  const workspaceName = workspaceDenied ? undefined : workspace.data?.workspace.id === workspaceId ? workspace.data.workspace.name
    : workspaceId ? cachedWorkspaceName(client, workspaceId) : undefined
  const workflowName = workspaceDenied || workflowDenied ? undefined : workflow.data?.workflow.id === workflowId
    && workflow.data.workflow.workspaceId === workspaceId ? workflow.data.workflow.name : workflowId ? cachedWorkflowName(client, workflowId) : undefined
  const workspacePath = `/workspaces/${encodeURIComponent(workspaceId)}`
  const crumbs: Crumb[] = []
  if (segments[0] === 'workspaces' && workspaceId) {
    crumbs.push({ label: 'Workspaces', to: '/workspaces' }, { label: workspaceName ?? 'Workspace', to: workspacePath, pending: !workspaceName && !workspaceDenied && workspace.isPending })
    if (workflowId) {
      crumbs.push({ label: 'Workflows', to: `${workspacePath}/workflows` },
        { label: workflowName ?? 'Workflow', to: `${workspacePath}/workflows/${encodeURIComponent(workflowId)}/draft`,
          pending: !workflowName && !workflowDenied && workflow.isPending },
        { label: segments[4] === 'runs' || location.search.runId || location.search.selectedRunId ? 'Run graph' : 'Board', to: location.pathname })
    } else {
      const section = segments[2]
      crumbs.push({ label: section ? sectionNames[section] ?? 'Workspace' : 'Board', to: section ? `${workspacePath}/${section}` : workspacePath })
      if (segments[3]) crumbs.push({ label: sectionNames[segments[3]] ?? 'Details', to: location.pathname })
    }
  } else if (segments[0] === 'settings') {
    crumbs.push({ label: 'Settings', to: '/settings' })
    const section = segments[1]
    if (section) crumbs.push({ label: sectionNames[section] ?? 'Settings', to: `/settings/${section}`, search: {} })
    const search = location.search as Record<string, unknown>
    const harness = search.harness
    const role = search.role
    if (section === 'harnesses' && typeof harness === 'string' && harness in harnessNames) {
      crumbs.push({ label: harnessNames[harness as keyof typeof harnessNames], to: '/settings/harnesses', search: { ...search, section: 'model' } })
    } else if (section === 'agents' && typeof role === 'string' && role in rolePresentation) {
      const roleSearch = role === 'operator' ? { role } : { role, section: 'model' }
      crumbs.push({ label: rolePresentation[role as keyof typeof rolePresentation].title,
        to: '/settings/agents', search: roleSearch })
    }
    if (section === 'agents' && role === 'operator') {
      crumbs.push({ label: 'Initial prompt', to: '/settings/agents', search: { role } })
    } else if ((section === 'harnesses' && harness || section === 'agents' && role) && crumbs.length > 2) {
      crumbs.push({ label: harnessSections.find(entry => entry.id === (search.section ?? 'model'))?.label ?? 'Model & speed', to: location.pathname, search })
    }
    if (segments[2]) crumbs.push({ label: section === 'skills' ? segments[2] === 'new' ? 'New skill' : 'Skill' : 'Computer', to: location.pathname })
  } else crumbs.push({ label: segments[0] === 'approvals' ? 'Workspaces' : sectionNames[segments[0] ?? ''] ?? 'Workspaces', to: location.pathname })
  const search = location.search as Record<string, unknown>
  const isOperatorPrompt = segments[1] === 'agents' && search.role === 'operator'
  const ancestors = segments[0] === 'settings' && (segments[1] === 'harnesses' || segments[1] === 'agents')
    && (isOperatorPrompt || search.section === undefined || search.section === 'model')
    && crumbs.length > 2 ? crumbs.slice(0, 2) : crumbs.slice(0, -1)
  const parent = ancestors.reverse().find(crumb => crumb.to !== location.pathname
    || [...new Set([...Object.keys(search), ...Object.keys(crumb.search ?? {})])].some(key => search[key] !== crumb.search?.[key]))
    ?? { label: 'Workspaces', to: '/workspaces' }
  const back = () => {
    if (canGoBack) router.history.back()
    else void router.navigate({ to: parent.to, search: parent.search ?? {} })
  }
  return <div className="app-navigation-trail">
    <button type="button" className="app-navigation-back" aria-label="Back" title="Back"
      disabled={!canGoBack && location.pathname === parent.to && crumbs.length === 1} onClick={back}>
      <ArrowLeft aria-hidden="true" size={16} />
    </button>
    <nav aria-label="Breadcrumbs"><ol>
      {crumbs.map((crumb, index) => <li key={`${index}:${crumb.to}`}>
        {index > 0 ? <ChevronRight aria-hidden="true" size={12} /> : null}
        {index === crumbs.length - 1 ? <span aria-current="page" title={crumb.label} className={crumb.pending ? 'is-pending' : undefined}>{crumb.label}</span>
          : <BreadcrumbLink crumb={crumb} />}
      </li>)}
    </ol></nav>
  </div>
}
