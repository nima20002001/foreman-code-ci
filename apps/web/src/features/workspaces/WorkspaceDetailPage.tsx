import { InfoHint } from '../../shared/ui/InfoHint'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { Button, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { WorkspaceSettingsHeader } from './WorkspaceSettingsHeader'
import { WorkspaceRepositoryForm } from './WorkspaceRepositoryForm'
import '../settings/settingsExperience.css'

export function WorkspaceDetailPage({ workspaceId, section, children }: {
  workspaceId: string; section: 'files' | 'workflows' | 'settings'; children?: ReactNode
}) {
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const blocked = useBlockingReadError(workspace)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined
  const title = section === 'files' ? 'Project files' : section === 'workflows' ? 'Workflows' : 'Settings'
  const unavailable = workspace.isError
    ? <ErrorState title="Workspace unavailable" description={workspace.error.message} onRetry={() => void workspace.refetch()} retrying={workspace.isFetching} />
    : <LoadingState label="Loading workspace…" rows={3} />
  // One frame for every state: the section navigation and the sections that only need the workspace id
  // never wait for the identity read, and nothing below the header remounts when it arrives.
  const settings = (actions: { rename(): void; remove(): void; chooseLocation(): void }) => <>
          {workspace.isError && unavailable}
          <div hidden={Boolean(blocked)}>
            <div className="workspace-settings-actions" role="group" aria-label="Workspace actions">
              <Button variant="ghost" onClick={actions.rename}>Rename workspace</Button>
              <Button variant="ghost" onClick={actions.chooseLocation}>Choose location</Button>
              <Button variant="danger" onClick={actions.remove}>Remove workspace</Button>
            </div>
            {current && <WorkspaceRepositoryForm key={workspaceId} workspaceId={workspaceId}
              revision={current.revision} repository={current.workspace.repository} />}
            {current && <section className="workspace-repository" aria-label="GitHub Actions CI">
              <div className="n-field-label"><h2>GitHub Actions CI</h2>
                {current.workspace.ciMirror && <InfoHint label="GitHub Actions CI">
                  CI also runs on free GitHub Actions runners in the public mirror. Main publishes only each tested commit's files there, without history, and refuses files that name your computers.
                </InfoHint>}
              </div>
              {current.workspace.ciMirror
                ? <p><code>{current.workspace.ciMirror.owner}/{current.workspace.ciMirror.name}</code></p>
                : <p>Not set up. Ask the Operator to set a public CI mirror for this workspace.</p>}
            </section>}
          </div>
        </>
  const content = (actions: { rename(): void; remove(): void; chooseLocation(): void }) => <div className="settings-editor-layout">
      <nav className="settings-editor-nav workspace-detail-nav" aria-label="Workspace sections">
        <Link to="/workspaces/$workspaceId/files" params={{ workspaceId }} aria-current={section === 'files' ? 'page' : undefined}>Project files<span aria-hidden="true">›</span></Link>
        <Link to="/workspaces/$workspaceId/workflows" params={{ workspaceId }} aria-current={section === 'workflows' ? 'page' : undefined}>Workflows<span aria-hidden="true">›</span></Link>
        <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} aria-current={section === 'settings' ? 'page' : undefined}>Settings<span aria-hidden="true">›</span></Link>
      </nav>
      <div className={`settings-editor-content workspace-detail-content${section === 'settings' ? ' workspace-detail-content--settings' : ''}`}>
        {!current && workspace.isError ? unavailable : children ?? (current ? settings(actions) : unavailable)}
      </div>
    </div>
  return <div className="settings-page settings-experience workspace-detail-page">
    <WorkspaceSettingsHeader key={workspaceId} workspaceId={workspaceId} name={current?.workspace.name} revision={current?.revision}
      failed={workspace.isError} title={title} renderContent={content} />
  </div>
}
