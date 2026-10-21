import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DockContext, type WorkflowOperatorDock } from './operatorDockContext'
import { OperatorChat } from '../operator-chat'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { useOperatorChatVisibility } from '../operator-chat/useOperatorChatVisibility'

export function WorkflowOperatorDockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<WorkflowOperatorDock | null>(null)
  const register = useCallback((value: WorkflowOperatorDock) => {
    setDock(value)
    return () => setDock(current => current === value ? null : current)
  }, [])
  const value = useMemo(() => ({ dock, register }), [dock, register])
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>
}

/** The root mounts one Operator body, in the Board rail or in its existing outside-Board shell. */
export function WorkflowOperatorChat({ settingsWarning }: { settingsWarning?: string }) {
  const dock = useContext(DockContext)?.dock
  const enabled = useOperatorChatVisibility()
  const open = useOperatorChatStore(state => state.open)
  const previous = useRef<{ scope?: string; active?: boolean; blocked?: boolean; open: boolean }>({ open })
  useEffect(() => {
    const prior = previous.current
    if (!enabled || !dock) { previous.current = { open }; return }
    let nextOpen = open
    if (prior.scope !== dock.scope) {
      if (open && !dock.active) dock.select({ kind: 'operator' })
      else nextOpen = dock.active && !dock.blocked
    } else if (prior.active !== dock.active || prior.blocked !== dock.blocked) {
      nextOpen = dock.active && !dock.blocked
    } else if (prior.open !== open && !dock.blocked) {
      if (open && !dock.active) dock.select({ kind: 'operator' })
      else if (!open && dock.active) dock.close()
    }
    previous.current = { scope: dock.scope, active: dock.active, blocked: dock.blocked, open: nextOpen }
    if (nextOpen !== open) useOperatorChatStore.getState().setOpen(nextOpen)
  }, [dock, enabled, open])
  if (!enabled) return dock?.active && !dock.blocked && dock.host
    ? createPortal(<p role="status">Operator chat is hidden in Agent settings.</p>, dock.host) : null
  if (!dock) return <OperatorChat settingsWarning={settingsWarning} />
  if (dock.active && !dock.blocked && dock.host) return createPortal(<OperatorChat settingsWarning={settingsWarning} />, dock.host)
  return <button type="button" className="workflow-operator-launcher" onClick={() => dock.select({ kind: 'operator' })}>Open Operator</button>
}
