import { createContext } from 'react'
import type { ApprovalHandler } from '@foreman-code/contracts'
import type { GraphRuntimeScope } from './runtimeIndex'

export const GraphNodeMenuContext = createContext<{
  workspaceId?: string
  workflowApprovalHandler?: ApprovalHandler
  designatedOrchestratorAgentId?: string
  setOpenMenuNodeId: (nodeId?: string) => void
} | undefined>(undefined)

export const GraphGeometryContext = createContext<{
  readOnly: boolean
  beginResize: () => void
  finishResize: (id: string, width: number, height: number, position?: { x: number; y: number }) => void
} | undefined>(undefined)

export const GraphRuntimeContext = createContext<GraphRuntimeScope | undefined>(undefined)
