import { PRODUCT_NAME } from '@foreman-code/contracts/product'
import { useCallback, useEffect, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'

import '../shared/ui/resourceDirectory.css'

import { ComputerSummaryCards } from '../features/computers/ComputerSummaryCards'
import { AgentsDirectory } from '../features/agents'
import { ProjectFilesSection } from '../features/project-files'
import { WorkflowDefaultsSettings, WorkspaceExecutionLocationSettings } from '../features/settings'
import { useApprovalInboxStore } from '../features/approvals'
import { WorkflowDirectory } from '../features/workflows'
import { WorkspaceDetailPage } from '../features/workspaces/WorkspaceDetailPage'
import { Badge, Card, EmptyState, Icon, PageHeader, type IconName } from '../shared/ui/nocturne'
import { WorkspaceShell, type WorkspaceSection } from '../shared/ui/WorkspaceShell'
import { useCollaborationUISlots } from '../shared/ui/collaborationSlots'
import { useManagedWorkspaceQuery } from '../shared/api/query'
import { MemoryBoardSurface } from '../features/workflow-board/MemoryBoardSurface'
import {
  WorkspaceDirectory,
  useNavigationUiStore,
  type GlobalNavigationSection,
} from '../features/workspaces'

export function WorkspacesRouteEntry() {
  const activeWorkspaceId = useNavigationUiStore((state) => state.activeWorkspaceId)

  return (
    <WorkspaceShell
      workspaceId={activeWorkspaceId ?? 'workspace-1'}
      workspaceOverviewActive
      slots={{ main: <WorkspaceDirectory /> }}
    />
  )
}

export function AgentsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/agents' })
  const { agentId } = useSearch({ from: '/workspaces/$workspaceId/agents' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId/agents' })
  const clearAgent = useCallback(() => {
    void navigate({
      replace: true,
      search: (previous) => {
        const next = { ...previous }
        delete next.agentId
        return next
      },
    })
  }, [navigate])
  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="agents"
      slots={{
        main: (
          <AgentsDirectory
            workspaceId={workspaceId}
            selectedAgentId={agentId}
            onClearAgent={clearAgent}
          />
        ),
      }}
    />
  )
}

export function WorkflowsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/workflows' })

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="workflows"
      slots={{ main: <WorkspaceDetailPage workspaceId={workspaceId} section="workflows"><WorkflowDirectory workspaceId={workspaceId} hideHeading /></WorkspaceDetailPage> }}
    />
  )
}

export function ComingSoonRouteEntry({ section, label }: { section: WorkspaceSection; label: string }) {
  const params = useParams({ strict: false })
  const workspaceId = 'workspaceId' in params && typeof params.workspaceId === 'string'
    ? params.workspaceId
    : 'workspace-1'

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection={section === 'terminal' || section === 'settings' ? 'workflows' : section}
      activeGlobalSection={section === 'terminal' || section === 'settings' ? section : undefined}
      slots={{
        main: (
          <div className="coming-soon-page" data-testid="coming-soon">
            <p className="n-eyebrow">{PRODUCT_NAME}</p>
            <EmptyState
              icon="clock"
              title={label}
              action={<Badge tone="neutral">Coming soon</Badge>}
            />
          </div>
        ),
      }}
    />
  )
}

export function GlobalComingSoonRouteEntry({
  section,
  label,
}: {
  section: GlobalNavigationSection
  label: string
}) {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection={section}
      slots={{
        main: (
          <div className="coming-soon-page" data-testid="coming-soon">
            <p className="n-eyebrow">{PRODUCT_NAME}</p>
            <EmptyState
              icon="clock"
              title={label}
              action={<Badge tone="neutral">Coming soon</Badge>}
            />
          </div>
        ),
      }}
    />
  )
}

export function SettingsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/settings' })
  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="settings"
      slots={{
        main: <WorkspaceDetailPage workspaceId={workspaceId} section="settings" />,
      }}
    />
  )
}

export function ProjectFilesRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/files' })
  return <WorkspaceShell workspaceId={workspaceId} activeSection="files" slots={{ main:
    <WorkspaceDetailPage workspaceId={workspaceId} section="files"><ProjectFilesSection workspaceId={workspaceId} /></WorkspaceDetailPage>,
  }} />
}

function WorkspaceMemoryBoard({ workspaceId }: { workspaceId: string }) {
  const workspace = useManagedWorkspaceQuery(workspaceId)
  return <MemoryBoardSurface scope={{ kind: 'workspace', workspaceId }} scopeName={workspace.data?.workspace.name ?? 'Workspace'} />
}

export function WorkspaceMemoryRouteEntry() {
  const { workspaceId } = useParams({ strict: false })
  const slots = useCollaborationUISlots()
  if (!workspaceId) return <EmptyState icon="folder" title="Choose a workspace" />
  return <WorkspaceShell workspaceId={workspaceId} activeSection="memory" slots={{ main:
    <WorkspaceDetailPage workspaceId={workspaceId} section="memory">
      <section aria-label="Workspace Memory board">{slots?.workspaceMemoryBoard?.({ workspaceId })
        ?? <WorkspaceMemoryBoard workspaceId={workspaceId} />}</section>
    </WorkspaceDetailPage>,
  }} />
}

function SettingsCardBody({ icon, title }: {
  icon: IconName
  title: string
}) {
  return (
    <>
      <span className="settings-card-icon"><Icon name={icon} size={16} /></span>
      <span className="settings-card-copy">
        <strong>{title}</strong>
      </span>
      <Icon className="settings-card-chevron" name="chevron" size={16} />
    </>
  )
}

function SettingsDetailPage({ eyebrow = PRODUCT_NAME, title, children }: {
  eyebrow?: string
  title: string
  children: ReactNode
}) {
  return (
    <div className="settings-page workspace-detail">
      <PageHeader eyebrow={eyebrow} title={title} />
      {children}
    </div>
  )
}

export { AgentSettingsRouteEntry, HarnessSettingsRouteEntry } from './SettingsExperienceRoutes'

export function GlobalSettingsRouteEntry() {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <div className="settings-page settings-hub">
            <PageHeader
              eyebrow={PRODUCT_NAME}
              title="Settings"
            />
            <h2 className="settings-group-heading" id="settings-preferences-heading">Preferences</h2>
            <ul className="settings-card-list" aria-labelledby="settings-preferences-heading">
              <li>
                <Card className="settings-card">
                  <Link to="/settings/general" className="settings-card-open">
                    <SettingsCardBody icon="settings" title="General" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/bugs" className="settings-card-open">
                    <SettingsCardBody icon="warning" title="Bugs" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/system-prompt" className="settings-card-open">
                    <SettingsCardBody icon="bot" title="System prompt" />
                  </Link>
                </Card>
              </li>
            </ul>
            <h2 className="settings-group-heading" id="settings-defaults-heading">Defaults</h2>
            <ul className="settings-card-list" aria-labelledby="settings-defaults-heading">
              <li>
                <Card className="settings-card">
                  <Link to="/settings/workspaces" className="settings-card-open">
                    <SettingsCardBody icon="folder" title="Workspaces" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/harnesses" className="settings-card-open">
                    <SettingsCardBody icon="settings" title="Harnesses" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/agents" className="settings-card-open">
                    <SettingsCardBody icon="bot" title="Agents" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/workflows" className="settings-card-open">
                    <SettingsCardBody icon="workflow" title="Workflows" />
                  </Link>
                </Card>
              </li>
            </ul>
            <h2 className="settings-group-heading" id="settings-computers-heading">Computers</h2>
            <Link to="/settings/browser-profiles" className="settings-card-open"><SettingsCardBody icon="settings" title="Browser profiles" /></Link>
            <ComputerSummaryCards />
            <h2 className="settings-group-heading" id="settings-library-heading">Library</h2>
            <ul className="settings-card-list" aria-labelledby="settings-library-heading">
              <li>
                <Card className="settings-card">
                  <Link to="/settings/skills" className="settings-card-open">
                    <SettingsCardBody icon="code" title="Skills" />
                  </Link>
                </Card>
              </li>
            </ul>
          </div>
        ),
      }}
    />
  )
}

export function WorkflowSettingsRouteEntry() {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <SettingsDetailPage
            title="Workflows"
          >
            <WorkflowDefaultsSettings />
          </SettingsDetailPage>
        ),
      }}
    />
  )
}

export function GlobalApprovalsRouteEntry() {
  // Old bookmarks lead to workspace choice, never a global queue or a guessed scope.
  return <WorkspacesRouteEntry />
}

export function WorkspaceApprovalsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/approvals' })
  const { workflowId } = useSearch({ from: '/workspaces/$workspaceId/approvals' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId/approvals' })
  useEffect(() => {
    useApprovalInboxStore.getState().openInbox({ workspaceId, workflowId })
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, search: workflowId ? { workflowId } : {}, replace: true })
  }, [navigate, workflowId, workspaceId])
  return null
}

export function WorkspaceLocationSettingsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/settings/location' })
  return <WorkspaceShell workspaceId={workspaceId} activeSection="settings" slots={{ main:
    <div className="settings-page workspace-detail">
      <WorkspaceExecutionLocationSettings key={workspaceId} workspaceId={workspaceId} presentation="card" />
    </div> }} />
}
