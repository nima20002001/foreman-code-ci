import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { errorMessage } from '../../shared/errorMessage'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  PanelsTopLeft,
  Workflow,
} from 'lucide-react'
import { WorkspaceFolderPicker } from '../settings/WorkspaceFolderPicker'
import { LoadMore } from '../../shared/ui/LoadMore'
import type { ComponentProps } from 'react'
import type { Workspace } from '@foreman-code/contracts'
import type { WorkspaceCreateInput } from '@foreman-code/contracts/management'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

import { queryKeys, useCreateManagedWorkspaceMutation, useManagedWorkspaceQuery, usePrefetchBoard } from '../../shared/api/query'
import { Button, Dialog, Icon, IconButton, TextField } from '../../shared/ui/nocturne'
import { useWorkspaceCreationDefaultsQuery } from '../../shared/api/settingsExperience'
import { usePresence } from '../../shared/ui/usePresence'
import { WorkflowNavigation } from '../workflows'
import { useNavigationUiStore } from './navigationUiStore'
import {
  WORKSPACES_ORDER_KEY,
  useNavigationOrderStore,
  workspaceSectionsOrderKey,
} from './navigationOrder'
import {
  useReorderableNavigation,
  type ReorderItemProps,
  type ReorderKeyboardProps,
} from './useReorderableNavigation'
import './workspaces.css'

export type WorkspaceSection =
  | 'memory'
  | 'agents'
  | 'workflows'
  | 'files'
  | 'tasks'
  | 'runs'
  | 'terminal'
  | 'settings'

export type GlobalNavigationSection = 'terminal' | 'settings'

export type WorkspaceNavigationEntry = Pick<Workspace, 'id' | 'name'>

export interface WorkspaceNavigationProps {
  workspaceId: string
  activeSection?: WorkspaceSection
  /** URL-owned workflow selection for the active workspace. */
  activeWorkflowId?: string
  /** Active top-level destination outside the workspace tree. */
  activeGlobalSection?: GlobalNavigationSection
  /**
   * Server-shaped workspace list. When omitted, the active workspace
   * projection from the workspace query is the only entry.
   */
  workspaces?: readonly WorkspaceNavigationEntry[]
  workspacePagination?: ComponentProps<typeof LoadMore>['query'] | undefined
  navigationCollapsed?: boolean
  /** The workspace directory is selected instead of a specific workspace. */
  workspaceOverviewActive?: boolean
  /** Route-supplied submenu content override for the active workspace. */
  workflowsContent?: ReactNode
}

const workspaceSections: readonly WorkspaceSection[] = [
  'workflows',
  'files',
  'tasks',
  'runs',
]

const workspaceSectionItems = [{ id: 'workflows', label: 'Workflows' }]

/** The always-visible, server-backed create entry point for the workspace list. */
function NewWorkspaceControl() {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [parentPath, setParentPath] = useState('')
  const touched = useRef({ name: false, parentPath: false, defaultsApplied: false })
  const defaults = useWorkspaceCreationDefaultsQuery(creating)
  const [nameError, setNameError] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const createManagedWorkspace = useCreateManagedWorkspaceMutation()
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceCreateInput, 'commandId'>>())
  const uncertain = attempt.current.unresolved && !createManagedWorkspace.isPending

  const closeCreateDialog = useCallback(() => {
    if (inFlight.current || attempt.current.unresolved) return
    setCreating(false)
    setName('')
    setParentPath('')
    touched.current = { name: false, parentPath: false, defaultsApplied: false }
    setNameError(undefined)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!creating || touched.current.defaultsApplied || attempt.current.unresolved) return
    const template = defaults.data
    if (!template) return
    touched.current.defaultsApplied = true
    if (!touched.current.name) setName(template.suggestedName)
    if (!touched.current.parentPath) setParentPath(template.parentPath ?? '')
  }, [creating, defaults.data])

  useEffect(() => {
    if (creating && name && !touched.current.name && document.activeElement === nameInputRef.current) {
      nameInputRef.current?.select()
    }
  }, [creating, name])


  const createNewWorkspace = async () => {
    if (inFlight.current || (defaults.isPending && !attempt.current.unresolved)) return
    const trimmedName = name.trim()
    if (!trimmedName) { setNameError('Enter a workspace name.'); nameInputRef.current?.focus(); return }
    if (!parentPath) { setNameError('Choose a location for the project folder.'); return }
    inFlight.current = true
    const generation = sessionGeneration()
    setNameError(undefined)
    try {
      const workspace = (await createManagedWorkspace.mutateAsync(
        attempt.current.input({ ...(touched.current.name ? { name: trimmedName } : {}), parentPath }),
      )).value.workspace
      assertSession(generation)
      attempt.current.succeeded()
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
        .catch(() => { /* ignore: the workspace was created; the list refreshes on its next query. */ })
      inFlight.current = false
      closeCreateDialog()
      void navigate({ to: '/workspaces/$workspaceId/settings', params: { workspaceId: workspace.id } })
    } catch (error) {
      attempt.current.failed(error)
      if (sessionGeneration() === generation) setNameError(errorMessage(error, 'The workspace could not be created.'))
    } finally { inFlight.current = false }
  }

  useUnsavedChanges({
    scope: 'surface', label: 'New workspace',
    dirty: creating && (touched.current.name || touched.current.parentPath),
    busy: createManagedWorkspace.isPending,
    uncertain,
    saveDisabled: !name.trim() || !parentPath.trim() || (defaults.isPending && !uncertain),
    error: nameError,
    save: createNewWorkspace,
    discard: closeCreateDialog,
  })

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        className="workspace-navigation-add"
        aria-label="New workspace"
        title="New workspace"
        aria-haspopup="dialog"
        aria-expanded={creating}
        leading={<Icon name="plus" size={15} />}
        onClick={() => setCreating(true)}
      >
        <span className="nav-item-label">New workspace</span>
      </Button>

      <Dialog
        open={creating}
        onOpenChange={(open) => { if (!open) closeCreateDialog() }}
        title="New workspace"
        closeLabel="Close new workspace"
        busy={createManagedWorkspace.isPending}
        initialFocusRef={nameInputRef}
        size="sm"
        footer={<>
          <Button onClick={closeCreateDialog}>Close</Button>
          <Button
            variant="primary"
            onClick={() => void createNewWorkspace()}
            disabled={createManagedWorkspace.isPending || (defaults.isPending && !uncertain)}
          >
            Create workspace
          </Button>
        </>}
      >
        <div className="n-stack">
          <TextField
            ref={nameInputRef}
            id="new-workspace-name"
            label="Name"
            disabled={createManagedWorkspace.isPending || uncertain}
            value={name}
            onFocus={(event) => { if (!touched.current.name) event.currentTarget.select() }}
            onChange={(event) => {
              touched.current.name = true
              setName(event.target.value)
              if (nameError) setNameError(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void createNewWorkspace()
              }
            }}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'new-workspace-name-error' : undefined}
          />
          <WorkspaceFolderPicker value={parentPath} label="Location" disabled={createManagedWorkspace.isPending || uncertain} onSelect={(path) => {
            touched.current.parentPath = true; setParentPath(path)
          }} />
          {defaults.isPending ? <p role="status">Loading workspace defaults…</p> : null}
          {defaults.isError ? <p role="status">Defaults could not be loaded. You can still enter your own values. <Button size="sm" onClick={() => void defaults.refetch()}>Retry defaults</Button></p> : null}
          {nameError ? (
            <p id="new-workspace-name-error" className="workspace-create-error" role="alert">
              {nameError}
            </p>
          ) : null}
          {uncertain ? <p role="status">The previous request may have succeeded. Retry Create workspace to resolve it without creating a duplicate.</p> : null}
        </div>
      </Dialog>
    </>
  )
}

interface WorkspaceTreeItemProps {
  entry: WorkspaceNavigationEntry
  active: boolean
  expanded: boolean
  onActivate: () => void
  onToggle: () => void
  activeWorkflowId?: string
  navigationCollapsed: boolean
  workflowsContent?: ReactNode
  reorderItemProps?: ReorderItemProps
  reorderKeyboardProps?: ReorderKeyboardProps
}

function WorkspaceTreeItem({
  entry,
  active,
  expanded,
  onActivate,
  onToggle,
  activeWorkflowId,
  navigationCollapsed,
  workflowsContent,
  reorderItemProps,
  reorderKeyboardProps,
}: WorkspaceTreeItemProps) {
  const prefetch = usePrefetchBoard()
  const workflowsExpanded = useNavigationUiStore(
    (state) => state.expandedSections[entry.id]?.workflows ?? true,
  )
  const setSectionExpanded = useNavigationUiStore((state) => state.setSectionExpanded)
  const sectionsPresence = usePresence(expanded)
  const workflowsPresence = usePresence(workflowsExpanded)

  const idPrefix = useId().replaceAll(':', '')
  const sectionsId = `${idPrefix}-sections`
  const workflowsPanelId = `${idPrefix}-workflows`

  const sections = useReorderableNavigation(
    workspaceSectionsOrderKey(entry.id),
    workspaceSectionItems,
  )

  const renderSection = (section: WorkspaceSection) => {
    const reorderProps = sections.getItemProps(section)
    if (section === 'workflows') {
      return (
        <>
          <div className="nav-item-row" {...reorderProps}>
            <SidebarNavigationButton
              to="/workspaces/$workspaceId/workflows"
              params={{ workspaceId: entry.id }}
              activeOptions={{ exact: true }}
              onMouseEnter={() => prefetch.workflows(entry.id)}
              onFocus={() => prefetch.workflows(entry.id)}
              activeProps={{ className: 'nav-item-active', 'aria-current': 'page' }}
              className="nav-item"
              {...sections.getKeyboardProps(section)}
              aria-label={navigationCollapsed ? 'Workflows' : undefined}
              title="Workflows"
            >
              <span className="nav-item-primary">
                <Workflow aria-hidden="true" className="nav-item-icon" size={16} />
                <span className="nav-item-label">Workflows</span>
              </span>
            </SidebarNavigationButton>
            <IconButton
              className="nav-item-toggle"
              label={`${workflowsExpanded ? 'Collapse' : 'Expand'} workflows in ${entry.name}`}
              aria-expanded={workflowsExpanded}
              aria-controls={workflowsPanelId}
              onClick={() => setSectionExpanded(entry.id, 'workflows', !workflowsExpanded)}
              {...sections.getKeyboardProps(section)}
            >
              <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
            </IconButton>
          </div>
          {workflowsPresence.mounted ? (
            <div
              className={`workspace-navigation-panel nav-submenu-motion${workflowsPresence.exiting ? ' is-exiting' : ''}`}
              id={workflowsPanelId}
              aria-hidden={!workflowsExpanded}
              inert={!workflowsExpanded ? true : undefined}
            >
              {(active ? workflowsContent : undefined) ?? (
                <WorkflowNavigation
                  workspaceId={entry.id}
                  activeWorkflowId={active ? activeWorkflowId : undefined}
                />
              )}
            </div>
          ) : null}
        </>
      )
    }

    return null
  }

  return (
    <li>
      <div className="nav-item-row" {...reorderItemProps}>
        <SidebarNavigationButton
          to="/workspaces/$workspaceId/settings"
          params={{ workspaceId: entry.id }}
          search={{}}
          activeOptions={{ exact: true, includeSearch: false }}
          className={`nav-item nav-item-parent${active ? ' nav-item-active' : ''}`}
          aria-current={active ? 'location' : undefined}
          aria-label={navigationCollapsed ? entry.name : undefined}
          title={entry.name}
          data-testid={`workspace-entry-${entry.id}`}
          onClick={onActivate}
          onMouseEnter={() => prefetch.workspace(entry.id)}
          onFocus={() => prefetch.workspace(entry.id)}
          {...reorderKeyboardProps}
        >
          <span className="nav-item-primary">
            <PanelsTopLeft aria-hidden="true" className="nav-item-icon" size={16} />
            <span className="nav-item-label">{entry.name}</span>
          </span>
        </SidebarNavigationButton>
        <IconButton
          className="nav-item-toggle"
          label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
          aria-expanded={expanded}
          aria-controls={sectionsId}
          onClick={onToggle}
          {...reorderKeyboardProps}
        >
          <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
        </IconButton>
      </div>

      {sectionsPresence.mounted ? (
        <ul
          className={`nav-submenu workspace-entry-sections nav-submenu-motion${sectionsPresence.exiting ? ' is-exiting' : ''}`}
          id={sectionsId}
          aria-hidden={!expanded}
          inert={!expanded ? true : undefined}
          {...sections.containerProps}
        >
          {sections.orderedIds.map((section) => {
            const sectionId = section as WorkspaceSection
            return (
              <li key={sectionId}>
                {renderSection(sectionId)}
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * The workspace-first sidebar hierarchy. Workspaces is the collapsible parent,
 * every workspace entry opens its settings and expands into Workflows.
 * App Settings lives in the shell footer.
 * The Agents destination remains routed but is temporarily hidden here.
 * Workspace and workflow lists are server-shaped query projections; selection
 * stays in the URL through router links.
 */
export function WorkspaceNavigation({
  workspaceId,
  activeSection = 'workflows',
  activeWorkflowId,
  activeGlobalSection,
  workspaces,
  navigationCollapsed = false,
  workspaceOverviewActive = false,
  workflowsContent,
  workspacePagination,
}: WorkspaceNavigationProps) {
  const detailsQuery = useManagedWorkspaceQuery(workspaceId)
  const rememberWorkspace = useNavigationUiStore((state) => state.rememberWorkspace)
  const workspacesExpanded = useNavigationUiStore((state) => state.workspacesExpanded)
  const setWorkspacesExpanded = useNavigationUiStore((state) => state.setWorkspacesExpanded)
  const expandedWorkspaceIds = useNavigationUiStore((state) => state.expandedWorkspaceIds)
  const setWorkspaceExpanded = useNavigationUiStore((state) => state.setWorkspaceExpanded)
  const workspacesPresence = usePresence(workspacesExpanded)

  useEffect(() => {
    if (!activeGlobalSection && !workspaceOverviewActive && detailsQuery.data?.workspace) {
      rememberWorkspace(workspaceId)
    }
  }, [activeGlobalSection, detailsQuery.data?.workspace, rememberWorkspace, workspaceId, workspaceOverviewActive])

  const entries = useMemo<readonly WorkspaceNavigationEntry[]>(
    () => {
      const next = [...(workspaces ?? [])]
      const known = new Set(next.map((entry) => entry.id))
      if (!workspaceOverviewActive && detailsQuery.data?.workspace && !known.has(workspaceId)) {
        next.unshift({
          id: workspaceId,
          name: detailsQuery.data.workspace.name,
        })
        if (workspacePagination && workspaces?.length) next.length = workspaces.length
      }
      return next
    },
    [detailsQuery.data?.workspace, workspaces, workspaceId, workspaceOverviewActive, workspacePagination],
  )

  const entryItems = useMemo(
    () => entries.map((entry) => ({ id: entry.id, label: entry.name })),
    [entries],
  )
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  )
  const entriesReorder = useReorderableNavigation(WORKSPACES_ORDER_KEY, entryItems)
  const announcement = useNavigationOrderStore((state) => state.announcement)

  const toggleWorkspace = (id: string) => {
    setWorkspaceExpanded(id, !(expandedWorkspaceIds[id] ?? id === workspaceId))
  }

  const workspacesActive = workspaceOverviewActive || (
    !activeGlobalSection && workspaceSections.includes(activeSection)
  )

  return (
    <>
      <ul className="workspace-navigation" data-testid="workspace-navigation">
        <li>
          <div className="nav-item-row">
            <SidebarNavigationButton
              to="/workspaces"
              activeOptions={{ exact: true }}
              className={`nav-item nav-item-parent${workspacesActive ? ' nav-item-active' : ''}`}
              aria-label={navigationCollapsed ? 'Workspaces' : undefined}
              title="Workspaces"
            >
              <span className="nav-item-primary">
                <PanelsTopLeft aria-hidden="true" className="nav-item-icon" size={16} />
                <span className="nav-item-label">Workspaces</span>
              </span>
            </SidebarNavigationButton>
            <IconButton
              className="nav-item-toggle"
              label="Workspaces"
              aria-expanded={workspacesExpanded}
              aria-controls="workspace-entries"
              onClick={() => setWorkspacesExpanded(!workspacesExpanded)}
            >
              <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
            </IconButton>
          </div>

          {workspacesPresence.mounted ? (
            <ul
              className={`nav-submenu workspace-navigation-list nav-submenu-motion${workspacesPresence.exiting ? ' is-exiting' : ''}`}
              id="workspace-entries"
              aria-hidden={!workspacesExpanded}
              inert={!workspacesExpanded ? true : undefined}
              {...entriesReorder.containerProps}
            >
              {entriesReorder.orderedIds.map((entryId) => {
                const entry = entryById.get(entryId)
                if (!entry) return null
                return (
                  <WorkspaceTreeItem
                    key={entry.id}
                    entry={entry}
                    active={entry.id === workspaceId && !activeGlobalSection && !workspaceOverviewActive}
                    expanded={expandedWorkspaceIds[entry.id] ?? (
                      entry.id === workspaceId && !activeGlobalSection && !workspaceOverviewActive
                    )}
                    onActivate={() => rememberWorkspace(entry.id)}
                    onToggle={() => toggleWorkspace(entry.id)}
                    activeWorkflowId={activeWorkflowId}
                    navigationCollapsed={navigationCollapsed}
                    workflowsContent={workflowsContent}
                    reorderItemProps={entriesReorder.getItemProps(entry.id)}
                    reorderKeyboardProps={entriesReorder.getKeyboardProps(entry.id)}
                  />
                )
              })}
              {workspacePagination ? <li><LoadMore label="workspaces" query={workspacePagination} /></li> : null}
              <li>
                <NewWorkspaceControl />
              </li>
            </ul>
          ) : null}
        </li>
      </ul>

      <p
        key={announcement?.nonce ?? 0}
        className="visually-hidden"
        data-testid="navigation-reorder-announcement"
        role="status"
        aria-live="polite"
      >
        {announcement?.message ?? ''}
      </p>
    </>
  )
}
