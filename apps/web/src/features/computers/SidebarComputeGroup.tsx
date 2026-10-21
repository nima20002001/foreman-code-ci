import { useEffect, useRef, type ReactNode } from 'react'
import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'
import { useSidebarHoverCard } from '../../shared/ui/useSidebarHoverCard'
import type { ComputerLoadLevel } from './computerLoad'

export function SidebarComputeGroup({ name, icon, level, runningCount, activityIds, children }: {
  name: string; icon: ReactNode; level: ComputerLoadLevel; runningCount: number; activityIds?: string[]; children: ReactNode
}) {
  const hover = useSidebarHoverCard({ label: name })
  return <li data-load={level}>
    <SidebarNavigationButton {...hover.anchorProps} to="/settings/computers" className="sidebar-computer" aria-label={name}>
      <ComputerIcon icon={icon} runningCount={runningCount} activityIds={activityIds} />
    </SidebarNavigationButton>
    {hover.card(<div className="sidebar-hover-body">
      <strong className="sidebar-compute-title">{name}</strong>
      {children}
    </div>)}
  </li>
}

function ComputerIcon({ icon, runningCount, activityIds }: {
  icon: ReactNode; runningCount: number; activityIds: string[] | undefined
}) {
  const glyph = useRef<HTMLSpanElement>(null)
  const previous = useRef({ runningCount, activityIds })
  useEffect(() => {
    const started = activityIds
      ? activityIds.some(id => !previous.current.activityIds?.includes(id))
      : runningCount > previous.current.runningCount
    previous.current = { runningCount, activityIds }
    if (!started || runningCount === 0) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (motion.matches) return
    const animation = glyph.current?.animate([
      { transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' },
    ], { duration: 300, easing: 'ease-out' })
    function stopMotion() { if (motion.matches) animation?.cancel() }
    motion.addEventListener('change', stopMotion)
    return () => {
      animation?.cancel()
      motion.removeEventListener('change', stopMotion)
    }
  }, [activityIds, runningCount])
  return <span className="sidebar-computer-icon" data-running={runningCount > 0 ? '' : undefined} aria-hidden="true">
    <span ref={glyph} className="sidebar-computer-glyph">{icon}</span>
    {runningCount > 0 && <span className="sidebar-computer-count">{runningCount > 9 ? '9+' : runningCount}</span>}
  </span>
}
