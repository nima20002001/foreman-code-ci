import { createContext, useContext, useEffect, useMemo } from 'react'
import type { BoardSidePanel } from '@foreman-code/contracts/wave25'

export interface WorkflowOperatorDock {
  scope: string
  host: HTMLDivElement | null
  active: boolean
  blocked: boolean
  select(selection: BoardSidePanel): void
  close(): void
}
export const DockContext = createContext<{
  dock: WorkflowOperatorDock | null
  register(value: WorkflowOperatorDock): () => void
} | null>(null)

export function useWorkflowOperatorDock(scope: string, host: HTMLDivElement | null, active: boolean,
  blocked: boolean, select: (selection: BoardSidePanel) => void, close: () => void) {
  const register = useContext(DockContext)?.register
  const dock = useMemo(() => ({ scope, host, active, blocked, select, close }), [scope, host, active, blocked, select, close])
  useEffect(() => register?.(dock), [register, dock])
}

