import { useManagedAgentsQuery } from '../../shared/api/query'

/** Saved Agent assignments include both the latest and older skill versions. */
export function useSkillAssignments(workspaceId: string, skillId: string) {
  const query = useManagedAgentsQuery(workspaceId)
  const agents = query.data?.items
    .filter(({ agent }) => agent.assignedSkills?.some((skill) => skill.skillId === skillId))
    .map(({ agent }) => agent) ?? []
  return { query, agents }
}
