import { managedBrowserSkillId } from './browserSkill.js'
import type { AgentConfigurationVersion, ResolvedSkill, NodeBrowserSettings } from '@foreman-code/contracts'
import type { NodeSkillOverride } from '@foreman-code/contracts/wave25'
import { verifiedSkills } from './instructions.js'
import { DomainError } from '../errors.js'

/** One workflow node's skills: the Agent's assigned skills minus the removed ones, then the added exact
 * versions from the saved workflow snapshot. The pinned Agent version is unchanged. */
export function configurationWithNodeSkills(configuration: AgentConfigurationVersion,
  override: NodeSkillOverride | undefined, additions: readonly ResolvedSkill[] = [],
  browser?: NodeBrowserSettings): AgentConfigurationVersion {
  const managed = browser?.enabled ? additions.find(skill => skill.skillId === managedBrowserSkillId) : undefined
  if (browser?.enabled && !managed) throw new DomainError('BROWSER_SKILL_SNAPSHOT_MISSING',
    'Save this workflow to capture its managed browser skill before launching it.', 409)
  const userAdditions = additions.filter(skill => skill.skillId !== managedBrowserSkillId)
  const removed = new Set(override?.remove ?? [])
  const references = [...configuration.assignedSkills.filter(skill => !removed.has(skill.skillId)), ...override?.add ?? []]
  if (references.length > 100) throw new DomainError('SKILL_LIMIT_EXCEEDED', 'At most 100 skills can be assigned.', 400)
  if (new Set(references.map(skill => skill.skillId)).size !== references.length) {
    throw new DomainError('SKILL_DUPLICATE', 'Assign only one version of each skill.', 400)
  }
  const resolvedSkills = [
    ...verifiedSkills(configuration).filter(skill => !removed.has(skill.skillId)),
    ...verifiedSkills({ assignedSkills: override?.add ?? [], resolvedSkills: userAdditions }),
  ]
  if (managed) { references.push({ skillId: managed.skillId, version: managed.version }); resolvedSkills.push(managed) }
  if (references.length > 100) throw new DomainError('SKILL_LIMIT_EXCEEDED', 'At most 100 skills can be assigned.', 400)
  const effective = { ...configuration, assignedSkills: references, resolvedSkills,
    ...(managed ? { instructionDelivery: 'native-v1' as const } : {}) }
  verifiedSkills(effective)
  return effective
}
