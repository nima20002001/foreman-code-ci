import { create } from 'zustand'
import type { Agent } from '@foreman-code/contracts'

import {
  deleteAgentForSession,
  clearWorkspaceAgents,
  readDeletedAgentIds,
  readLocalAgents,
  writeLocalAgents,
} from './localAgents'

export {
  applyStoredOrder as applyAgentOrder,
  moveItemRelative as moveAgentRelative,
  moveItemToIndex as moveAgentToIndex,
} from '../../shared/ui/listOrder'

export interface AgentDirectoryAnnouncement {
  message: string
  nonce: number
}

interface AgentDirectoryState {
  orders: Readonly<Record<string, readonly string[]>>
  catalogs: Readonly<Record<string, { localAgents: readonly Agent[]; deletedAgentIds: readonly string[] }>>
  announcement: AgentDirectoryAnnouncement | null
  setOrder: (workspaceId: string, ids: readonly string[]) => void
  hydrateWorkspace: (workspaceId: string) => void
  setLocalAgents: (workspaceId: string, agents: readonly Agent[]) => void
  deleteAgent: (workspaceId: string, agentId: string) => void
  removeWorkspace: (workspaceId: string) => void
  announce: (message: string) => void
  reset: () => void
}

/**
 * Agent card ordering is interaction state: it belongs to one workspace and
 * survives route remounts for the current session, but is not server data or
 * URL state. Unknown and removed ids are intentionally retained here so a
 * later query refresh can put an existing agent back in its previous place.
 */
export const useAgentDirectoryStore = create<AgentDirectoryState>((set) => ({
  orders: {},
  catalogs: {},
  announcement: null,
  setOrder: (workspaceId, ids) =>
    set((state) => ({ orders: { ...state.orders, [workspaceId]: [...ids] } })),
  hydrateWorkspace: (workspaceId) =>
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [workspaceId]: {
          localAgents: readLocalAgents(workspaceId),
          deletedAgentIds: readDeletedAgentIds(workspaceId),
        },
      },
    })),
  setLocalAgents: (workspaceId, agents) => {
    writeLocalAgents(workspaceId, agents)
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [workspaceId]: {
          localAgents: [...agents],
          deletedAgentIds:
            state.catalogs[workspaceId]?.deletedAgentIds ?? readDeletedAgentIds(workspaceId),
        },
      },
    }))
  },
  deleteAgent: (workspaceId, agentId) => {
    const catalog = deleteAgentForSession(workspaceId, agentId)
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [workspaceId]: catalog,
      },
    }))
  },
  removeWorkspace: (workspaceId) => {
    clearWorkspaceAgents(workspaceId)
    set((state) => {
      const orders = { ...state.orders }
      const catalogs = { ...state.catalogs }
      delete orders[workspaceId]
      delete catalogs[workspaceId]
      return { orders, catalogs }
    })
  },
  announce: (message) =>
    set((state) => ({
      announcement: { message, nonce: (state.announcement?.nonce ?? 0) + 1 },
    })),
  reset: () => set({ orders: {}, catalogs: {}, announcement: null }),
}))
