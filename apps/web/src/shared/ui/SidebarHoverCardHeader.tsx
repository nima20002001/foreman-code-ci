import type { ReactNode } from 'react'
import './sidebarHoverCard.css'

export function SidebarHoverCardHeader({ icon, name, role }: { icon: ReactNode; name: string; role: string }) {
  return <header className="sidebar-hover-header"><span aria-hidden="true">{icon}</span><strong>{name}</strong><span>{role}</span></header>
}
