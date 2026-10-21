import { PRODUCT_NAME } from '@foreman-code/contracts/product'
import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Settings } from 'lucide-react'
import { SidebarNavigationButton } from './SidebarNavigationButton'

import { SidebarComputers } from '../../features/computers/SidebarComputers'
import { SidebarMemoryBoardButton } from '../../features/memory-boards/SidebarMemoryBoardButton'
import { ThemeToggle } from '../../features/theme'
import { HarnessStatusMenu } from '../../features/settings/HarnessStatusMenu'
import { useWorkspacePages } from '../api/query'
import { EmptyState } from './nocturne'
import { AppNavigationTrail } from './AppNavigationTrail'
import { COLLAPSED_NAVIGATION_WIDTH } from '../../features/workspaces/navigationUiStore'
import {
  DEFAULT_NAVIGATION_WIDTH,
  MAX_NAVIGATION_WIDTH,
  MIN_NAVIGATION_WIDTH,
  WorkspaceNavigation,
  type GlobalNavigationSection,
  type WorkspaceNavigationEntry,
  type WorkspaceSection,
  useNavigationUiStore,
} from '../../features/workspaces'

export type { WorkspaceSection } from '../../features/workspaces'

export interface WorkspaceShellSlots {
  /** Content for the workspace slot in the header. */
  workspace?: ReactNode
  /** Content for the runner slot in the header. */
  runner?: ReactNode
  /** Center graph surface. */
  graph?: ReactNode
  /** Bottom terminal surface. */
  terminal?: ReactNode
  /** Non-graph workspace content, such as a directory page. */
  main?: ReactNode
}

export interface WorkspaceShellProps {
  workspaceId: string
  slots?: WorkspaceShellSlots
  activeSection?: WorkspaceSection
  /** URL-owned workflow selection handed to the nested Workflows submenu. */
  activeWorkflowId?: string
  /** Top-level destination outside the workspace tree. */
  activeGlobalSection?: GlobalNavigationSection
  /** Workspace directory is selected instead of an individual workspace. */
  workspaceOverviewActive?: boolean
  /** Server-shaped workspace list; defaults to the active workspace projection. */
  workspaces?: readonly WorkspaceNavigationEntry[]
}

function DefaultGraph({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="surface-placeholder">
      <EmptyState
        icon="workflow"
        title="Workflow graph"
        description={`No graph connected for workspace ${workspaceId}.`}
      />
    </div>
  )
}

export function WorkspaceShell({
  workspaceId,
  slots = {},
  activeSection = 'workflows',
  activeWorkflowId,
  activeGlobalSection,
  workspaceOverviewActive = false,
  workspaces,
}: WorkspaceShellProps) {
  const workspacesQuery = useWorkspacePages(workspaces === undefined)
  const navigationWorkspaces = workspaces ?? workspacesQuery.data?.pages.flatMap((page) => page.items.map((item) => item.workspace))
  const { navigationCollapsed, navigationWidth, resizeWidth, navigationMotion,
    startResize, resizeWithKeyboard, resetWidth } = useNavigationResize()
  const rememberedWorkspaceId = useNavigationUiStore((state) => state.activeWorkspaceId)
  const navigationWorkspaceId = activeGlobalSection
    ? rememberedWorkspaceId ?? workspaceId
    : workspaceId


  return (
    <div
      className={`workspace-shell${navigationCollapsed ? ' workspace-shell-navigation-collapsed' : ''}`}
      data-testid="workspace-shell"
      data-navigation-motion={navigationMotion}
      style={{ '--navigation-width': `${resizeWidth ?? navigationWidth}px` } as CSSProperties}
    >
      <aside
        className="shell-sidebar"
        aria-label="Primary navigation"
        data-collapsed={navigationCollapsed}
      >
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemin={navigationCollapsed || resizeWidth !== null ? COLLAPSED_NAVIGATION_WIDTH : MIN_NAVIGATION_WIDTH}
          aria-valuemax={MAX_NAVIGATION_WIDTH}
          aria-valuenow={navigationCollapsed ? COLLAPSED_NAVIGATION_WIDTH : resizeWidth ?? navigationWidth}
          aria-valuetext={navigationCollapsed ? 'Navigation collapsed. Drag right to expand.' : `${resizeWidth ?? navigationWidth} pixels`}
          aria-controls="workspace-primary-navigation"
          aria-keyshortcuts="Control+b Meta+b Enter Space ArrowLeft ArrowRight Home End"
          tabIndex={0}
          title="Drag to resize navigation. Ctrl/Cmd+B or Enter toggles navigation. Arrow keys resize."
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={resetWidth}
        />

        <nav className="shell-navigation" id="workspace-primary-navigation">
          <p className="sidebar-brand" data-testid="sidebar-brand" role="img" aria-label={PRODUCT_NAME}>
            <span aria-hidden="true" className="sidebar-brand-mark">
              F
            </span>
            <span className="sidebar-brand-name">{PRODUCT_NAME}</span>
          </p>

          <WorkspaceNavigation
            workspaceId={navigationWorkspaceId}
            activeSection={activeSection}
            activeWorkflowId={activeWorkflowId}
            activeGlobalSection={activeGlobalSection}
            workspaceOverviewActive={workspaceOverviewActive}
            workspaces={navigationWorkspaces}
            workspacePagination={workspaces === undefined ? workspacesQuery : undefined}
            navigationCollapsed={navigationCollapsed}
          />
        </nav>

        <div className="sidebar-footer">
          <SidebarComputers />
          <div className="sidebar-preferences-row">
            <SidebarNavigationButton
              to="/settings"
              className={`sidebar-settings-link${activeGlobalSection === 'settings' ? ' sidebar-settings-link-active' : ''}`}
              aria-current={activeGlobalSection === 'settings' ? 'page' : undefined}
              aria-label="Settings"
              title="Settings"
            >
              <Settings aria-hidden="true" size={16} />
            </SidebarNavigationButton>
            {navigationWorkspaceId && <SidebarMemoryBoardButton workspaceId={navigationWorkspaceId}
              active={!activeGlobalSection && activeSection === 'memory'} />}
            <ThemeToggle />
            <HarnessStatusMenu />
          </div>
        </div>
      </aside>

      <main className="shell-main">
        <AppNavigationTrail activeWorkflowId={activeWorkflowId} />
        {slots.main ? (
          <section className="shell-content" data-slot="main" aria-label="Workspace content">
            {slots.main}
          </section>
        ) : (
          <>
            <section className="graph-surface" data-slot="graph" aria-label="Workflow graph">
              {slots.graph ?? <DefaultGraph workspaceId={workspaceId} />}
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function useNavigationResize() {
  const navigationCollapsed = useNavigationUiStore((state) => state.collapsed)
  const navigationWidth = useNavigationUiStore((state) => state.width)
  const resizeWidth = useNavigationUiStore((state) => state.resizeWidth)
  const navigationMotion = useNavigationUiStore((state) => state.motion)
  const setCollapsed = useNavigationUiStore((state) => state.setCollapsed)
  const setNavigationWidth = useNavigationUiStore((state) => state.setWidth)
  const setResizeWidth = useNavigationUiStore((state) => state.setResizeWidth)
  const stopResizeRef = useRef<(() => void) | null>(null)
  const resizeCollapsedRef = useRef<boolean | null>(null)

  useEffect(() => () => stopResizeRef.current?.(), [])

  useEffect(() => {
    if (stopResizeRef.current && navigationCollapsed !== resizeCollapsedRef.current) stopResizeRef.current()
  }, [navigationCollapsed])

  useEffect(() => {
    const toggleNavigation = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'b') return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])')) return
      event.preventDefault()
      stopResizeRef.current?.()
      setCollapsed(!useNavigationUiStore.getState().collapsed)
    }
    window.addEventListener('keydown', toggleNavigation)
    return () => window.removeEventListener('keydown', toggleNavigation)
  }, [setCollapsed])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const phone = window.matchMedia('(max-width: 640px)')
    const collapseForPhone = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setCollapsed(true)
    }
    collapseForPhone(phone)
    phone.addEventListener('change', collapseForPhone)
    return () => phone.removeEventListener('change', collapseForPhone)
  }, [setCollapsed])

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || stopResizeRef.current) return
    event.preventDefault()

    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width
      || (navigationCollapsed ? COLLAPSED_NAVIGATION_WIDTH : navigationWidth)
    const rememberedWidth = navigationCollapsed ? navigationWidth : startWidth
    let finalWidth = navigationWidth
    let moved = false
    let collapsed = navigationCollapsed

    const stop = () => {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', stop)
      stopResizeRef.current = null
      resizeCollapsedRef.current = null
      if (moved) setNavigationWidth(collapsed ? rememberedWidth : finalWidth, useNavigationUiStore.getState().motion)
    }
    const resize = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const rawWidth = startWidth + moveEvent.clientX - startX
      if (collapsed) {
        if (navigationCollapsed ? rawWidth <= startWidth : rawWidth < startWidth / 2) return
        collapsed = false
        resizeCollapsedRef.current = false
        setCollapsed(false, 'manual')
      }
      if (rawWidth < startWidth / 2) {
        collapsed = true
        resizeCollapsedRef.current = true
        moved = true
        setCollapsed(true, 'manual')
        return
      }
      finalWidth = Math.min(MAX_NAVIGATION_WIDTH, Math.max(COLLAPSED_NAVIGATION_WIDTH, window.innerWidth - COLLAPSED_NAVIGATION_WIDTH), rawWidth)
      finalWidth = Math.max(COLLAPSED_NAVIGATION_WIDTH, finalWidth)
      moved = true
      setResizeWidth(finalWidth)
    }
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) stop()
    }

    stopResizeRef.current = stop
    resizeCollapsedRef.current = collapsed
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', stop)
  }, [navigationCollapsed, navigationWidth, setCollapsed, setNavigationWidth, setResizeWidth])

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      stopResizeRef.current?.()
      setCollapsed(!navigationCollapsed)
      return
    }
    const step = event.shiftKey ? 32 : 8
    let nextWidth: number | undefined
    if (event.key === 'ArrowLeft') nextWidth = navigationWidth - step
    if (event.key === 'ArrowRight') nextWidth = navigationWidth + step
    if (event.key === 'Home') nextWidth = MIN_NAVIGATION_WIDTH
    if (event.key === 'End') nextWidth = MAX_NAVIGATION_WIDTH
    if (nextWidth === undefined) return
    event.preventDefault()
    stopResizeRef.current?.()
    if (navigationCollapsed && event.key === 'ArrowLeft') return
    setCollapsed(false)
    setNavigationWidth(nextWidth)
  }

  const resetWidth = () => {
    stopResizeRef.current?.()
    setNavigationWidth(DEFAULT_NAVIGATION_WIDTH, 'manual')
    setCollapsed(false, 'manual')
  }
  return { navigationCollapsed, navigationWidth, resizeWidth, navigationMotion,
    startResize, resizeWithKeyboard, resetWidth }
}
