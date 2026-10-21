import type { AgentConfigurationVersion, ResolvedSkill } from '@foreman-code/contracts'
import type { NodeSkillOverride } from '@foreman-code/contracts/wave25'
import { verifiedSkills } from './instructions.js'
import { DomainError } from '../errors.js'

/** One workflow node's skills: the Agent's assigned skills minus the removed ones, then the added exact
 * versions from the saved workflow snapshot. The pinned Agent version is unchanged. */
export function configurationWithNodeSkills(configuration: AgentConfigurationVersion,
  override: NodeSkillOverride, additions: readonly ResolvedSkill[] = []): AgentConfigurationVersion {
  const removed = new Set(override.remove ?? [])
  const references = [...configuration.assignedSkills.filter(skill => !removed.has(skill.skillId)), ...override.add ?? []]
  if (references.length > 100) throw new DomainError('SKILL_LIMIT_EXCEEDED', 'At most 100 skills can be assigned.', 400)
  if (new Set(references.map(skill => skill.skillId)).size !== references.length) {
    throw new DomainError('SKILL_DUPLICATE', 'Assign only one version of each skill.', 400)
  }
  const resolvedSkills = [
    ...verifiedSkills(configuration).filter(skill => !removed.has(skill.skillId)),
    ...verifiedSkills({ assignedSkills: override.add ?? [], resolvedSkills: additions }),
  ]
  const effective = { ...configuration, assignedSkills: references, resolvedSkills }
  verifiedSkills(effective)
  return effective
}
