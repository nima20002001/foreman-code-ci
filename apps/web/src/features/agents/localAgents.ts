import { AgentSchema, type Agent } from '@foreman-code/contracts'

function localAgentsKey(workspaceId: string) {
  return `graphql-local-agents:${workspaceId}`
}

function deletedAgentsKey(workspaceId: string) {
  return `graphql-deleted-agents:${workspaceId}`
}

export function readLocalAgents(workspaceId: string): Agent[] {
  try {
    const value = sessionStorage.getItem(localAgentsKey(workspaceId))
    if (!value) return []
    const parsed = AgentSchema.array().safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function writeLocalAgents(workspaceId: string, agents: readonly Agent[]) {
  sessionStorage.setItem(localAgentsKey(workspaceId), JSON.stringify(AgentSchema.array().parse(agents)))
}

export function readDeletedAgentIds(workspaceId: string): string[] {
  try {
    const value = sessionStorage.getItem(deletedAgentsKey(workspaceId))
    if (!value) return []
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0))]
  } catch {
    return []
  }
}

export function deleteAgentForSession(workspaceId: string, agentId: string) {
  const localAgents = readLocalAgents(workspaceId).filter((agent) => agent.id !== agentId)
  const deletedAgentIds = [...new Set([...readDeletedAgentIds(workspaceId), agentId])]
  writeLocalAgents(workspaceId, localAgents)
  sessionStorage.setItem(deletedAgentsKey(workspaceId), JSON.stringify(deletedAgentIds))
  return { localAgents, deletedAgentIds }
}

export function clearWorkspaceAgents(workspaceId: string): void {
  sessionStorage.removeItem(localAgentsKey(workspaceId))
  sessionStorage.removeItem(deletedAgentsKey(workspaceId))
}
