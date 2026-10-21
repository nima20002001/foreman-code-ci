import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import './workspaceLocation.css'

/** A workspace needs a usable folder before its board can be opened. */
export function WorkspaceExecutionLocationSetup({ workspaceId, children, enabled }: {
  workspaceId: string
  children: ReactNode
  enabled: boolean
}) {
  const workspace = useManagedWorkspaceQuery(workspaceId, enabled)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined
  if (!enabled) return <>{children}</>
  if (current?.locationValidation.status === 'ready') {
    return <div className="workspace-execution-surface">
      <div className="workspace-execution-content">{children}</div>
    </div>
  }

  let gate: ReactNode
  if (!current && workspace.isError) {
    gate = <ErrorState title="Execution folder could not be checked" description="The workspace could not be loaded. Try again to open its board."
      onRetry={() => void workspace.refetch()} retrying={workspace.isFetching} />
  } else if (!current) {
    gate = <LoadingState label="Checking the execution folder…" />
  } else if (current.locationValidation.status === 'restricted') {
    gate = <ErrorState title="Execution folder access is restricted" description="You do not have permission to read this workspace’s execution folder. Ask the workspace owner for access."
      onRetry={() => void workspace.refetch()} retrying={workspace.isFetching} />
  } else {
    const unavailable = current.locationValidation.status === 'unavailable'
    gate = <EmptyState icon={unavailable ? 'warning' : 'folder'}
      title={unavailable ? 'Execution folder unavailable' : 'Choose an execution folder'}
      description={current.locationValidation.status === 'unavailable' ? `${current.locationValidation.error.message} Choose an available folder to open this board.`
        : 'Choose a local folder for this workspace before opening its board.'}
      action={<Link className="n-button n-button--primary" to="/workspaces/$workspaceId/settings/location" params={{ workspaceId }}>
        {unavailable ? 'Change execution folder' : 'Choose execution folder'}
      </Link>} />
  }
  return (
    <div className="workspace-execution-surface workspace-location-gate">
      {gate}
    </div>
  )
}
