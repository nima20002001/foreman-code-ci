import { SquareKanban } from 'lucide-react'
import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'

/** The workspace Memory board lives with the environment controls in the sidebar footer. */
export function SidebarMemoryBoardButton({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  return <SidebarNavigationButton to="/workspaces/$workspaceId/memory" params={{ workspaceId }}
    className={`sidebar-settings-link${active ? ' sidebar-settings-link-active' : ''}`}
    aria-current={active ? 'page' : undefined} aria-label="Workspace memory board" title="Workspace memory board">
    <SquareKanban aria-hidden="true" size={16} />
  </SidebarNavigationButton>
}
