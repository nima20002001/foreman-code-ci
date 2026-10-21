import { useEffect, useRef } from 'react'
import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { ManagedWorkflow } from '@foreman-code/contracts/management'

import { useInteractionsQuery, useWorkflowPages, useManagedWorkflowQuery } from '../../shared/api/query'
import { usePrefetchWorkflowBoard } from '../workflow-board/prefetch'
import { LoadMore } from '../../shared/ui/LoadMore'
import { Badge, Button, IconButton } from '../../shared/ui/nocturne'
import { RemoveWorkflowButton } from './RemoveWorkflowButton'
import { NewWorkflowAction } from './NewWorkflowAction'
import { useWorkflowReorder } from './useWorkflowReorder'
import { useReorderableNavigation, type ReorderableNavigation } from '../workspaces/useReorderableNavigation'
import { ApiError } from '../../shared/api/client'
import './workflows.css'

export interface WorkflowNavigationProps {
  workspaceId: string
  /** URL-owned selection; undefined means no workflow is selected in the URL. */
  activeWorkflowId?: string
}

function WorkflowNavigationItem({
  item,
  workspaceId,
  active,
  pendingCount,
  reorder,
  index = 0,
  count = 0,
  reorderDisabled = false,
}: {
  item: ManagedWorkflow
  workspaceId: string
  active: boolean
  pendingCount: number | undefined
  reorder?: ReorderableNavigation
  index?: number
  count?: number
  reorderDisabled?: boolean
}) {
  const { workflow } = item
  const prefetch = usePrefetchWorkflowBoard()
  // The open workflow stays in sight in a long list instead of sitting clipped below the fold.
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => { if (active) row.current?.scrollIntoView?.({ block: 'nearest' }) }, [active])
  return (
    <li ref={row} className={`workflow-navigation-row${reorder ? ' workflow-navigation-row-reorderable' : ''}`}
      data-reorder-id={reorder ? workflow.id : undefined}>
      <SidebarNavigationButton
        to="/workspaces/$workspaceId"
        params={{ workspaceId }}
        search={{ workflowId: workflow.id }}
        className={`nav-item workflow-navigation-item${active ? ' nav-item-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        title={workflow.name}
        onPointerDown={reorder?.getItemProps(workflow.id).onPointerDown}
        {...reorder?.getKeyboardProps(workflow.id)}
        aria-describedby={reorder ? `workflow-order-help-${workspaceId}` : undefined}
        onMouseEnter={() => prefetch(workspaceId, workflow.id)}
        onFocus={() => prefetch(workspaceId, workflow.id)}
      >
        <span className="nav-item-label">{workflow.name}</span>
        {item.currentVersionId === null ? <Badge className="workflow-draft-badge">Draft</Badge> : null}
        {pendingCount === undefined ? <span className="visually-hidden">Approval count unavailable</span> : null}
        {pendingCount !== undefined && pendingCount > 0 ? <Badge tone="accent" className="workflow-approval-badge">{pendingCount}</Badge> : null}
      </SidebarNavigationButton>
      {reorder ? <div className="workflow-navigation-move">
        <IconButton label={`Move ${workflow.name} up`} variant="ghost" size="sm"
          disabled={reorderDisabled || index === 0} onClick={() => {
            row.current?.querySelector<HTMLButtonElement>('.workflow-navigation-item')?.focus()
            reorder.move(workflow.id, -1)
          }}><ArrowUp size={14} /></IconButton>
        <IconButton label={`Move ${workflow.name} down`} variant="ghost" size="sm"
          disabled={reorderDisabled || index === count - 1} onClick={() => {
            row.current?.querySelector<HTMLButtonElement>('.workflow-navigation-item')?.focus()
            reorder.move(workflow.id, 1)
          }}><ArrowDown size={14} /></IconButton>
      </div> : null}
      <RemoveWorkflowButton workspaceId={workspaceId} workflowId={workflow.id} name={workflow.name} revision={item.revision} />
    </li>
  )
}

/**
 * The nested workflow submenu for one workspace. Saved workflows come from the
 * managed API projection, and the selected workflow stays in the URL. New
 * workflow opens a compact creation dialog in the active workspace.
 */
export function WorkflowNavigation({ workspaceId, activeWorkflowId }: WorkflowNavigationProps) {
  return <WorkflowNavigationContent key={workspaceId} workspaceId={workspaceId} activeWorkflowId={activeWorkflowId} />
}

function WorkflowNavigationContent({ workspaceId, activeWorkflowId }: WorkflowNavigationProps) {
  const managedQuery = useWorkflowPages(workspaceId, true)
  const interactionsQuery = useInteractionsQuery({ workspaceId, status: 'pending', limit: 1 }, true)

  const workflows = [...new Map((managedQuery.data?.pages.flatMap(page => page.items) ?? [])
    .map(item => [item.workflow.id, item])).values()]
  const activeMissing = Boolean(activeWorkflowId && !workflows.some((item) => item.workflow.id === activeWorkflowId))
  const activeQuery = useManagedWorkflowQuery(workspaceId, activeWorkflowId ?? '', activeMissing)
  const selected = activeMissing && activeQuery.data && !activeQuery.data.archivedAt ? activeQuery.data : undefined
  const orderRevision = managedQuery.data?.pages[0]?.orderRevision ?? 0
  const order = useWorkflowReorder(workspaceId, orderRevision)
  const reorderDisabled = order.mutation.isPending || order.unresolved || !managedQuery.data
    || Boolean(managedQuery.data?.pages.some(page => page.orderRevision !== orderRevision))
  const reorder = useReorderableNavigation(`workspace:${workspaceId}:workflows`,
    workflows.map(item => ({ id: item.workflow.id, label: item.workflow.name })),
    { onReorder: order.save, disabled: reorderDisabled, revision: orderRevision })
  const byId = new Map(workflows.map(item => [item.workflow.id, item]))
  const hasWorkflows = workflows.length > 0
  const pendingCount = (workflowId: string) => interactionsQuery.isError ? undefined
    : interactionsQuery.data?.pendingByWorkflow?.[workflowId]
      ?? (interactionsQuery.data?.pendingByWorkflow ? 0 : undefined)
  const conflict = order.mutation.error instanceof ApiError && order.mutation.error.code === 'REVISION_CONFLICT'
  let orderError = order.mutation.error?.message ?? 'Workflow order could not be saved.'
  if (conflict) orderError = 'Workflow order changed elsewhere. Your move was undone. Try again with the latest order.'
  else if (order.unresolved) orderError = 'The request may have succeeded. Retry saving order to confirm.'

  return (
    <section
      className="workflow-navigation"
      data-testid="workflow-navigation"
      aria-label="Workspace workflows"
    >
      <NewWorkflowAction workspaceId={workspaceId} navigation />
      {selected ? <div className="workflow-navigation-selected">
        <ul className="nav-submenu workflow-navigation-list">
          <WorkflowNavigationItem item={selected} workspaceId={workspaceId} active pendingCount={pendingCount(selected.workflow.id)} />
        </ul>
      </div> : null}
      <p id={`workflow-order-help-${workspaceId}`} className="visually-hidden">
        Drag workflows to reorder within this workspace, use the move up and down buttons,
        or press Alt+Arrow Up or Alt+Arrow Down on a workflow.
      </p>
      {order.mutation.isPending ? <p className="workflow-navigation-state" role="status">Saving workflow order…</p> : null}
      {order.mutation.isError ? <p className="workflow-navigation-state" role="alert">
        {orderError}
        {order.unresolved ? <Button size="sm" onClick={order.retry}>Retry saving order</Button> : null}
      </p> : null}
      {hasWorkflows ? (
        <ul className="nav-submenu workflow-navigation-list" {...reorder.containerProps}>
          {reorder.orderedIds.map((id, index) => {
            const item = byId.get(id)!
            const { workflow } = item
            const active = workflow.id === activeWorkflowId
            return <WorkflowNavigationItem
              key={workflow.id}
              item={item}
              workspaceId={workspaceId}
              active={active}
              pendingCount={pendingCount(workflow.id)}
              reorder={reorder}
              index={index}
              count={workflows.length}
              reorderDisabled={reorderDisabled}
            />
          })}
        </ul>
      ) : managedQuery.isPending ? (
        <p className="workflow-navigation-state" role="status">
          Loading workflows…
        </p>
      ) : managedQuery.isError ? (
        <p
          className="workflow-navigation-state workflow-navigation-state-error"
          data-testid="workflow-navigation-error"
          role="alert"
        >
          Workflows unavailable
        </p>
      ) : (
        <p className="workflow-navigation-state" data-testid="workflow-navigation-empty">
          No workflows yet
        </p>
      )}

      {hasWorkflows && managedQuery.isError ? (
        <p
          className="workflow-navigation-state workflow-navigation-state-error"
          data-testid="workflow-navigation-error"
          role="alert"
        >
          Workflows unavailable
        </p>
      ) : null}

      <LoadMore label="workflows" query={{ ...managedQuery, isFetching: managedQuery.isFetching || order.mutation.isPending }} />
    </section>
  )
}
