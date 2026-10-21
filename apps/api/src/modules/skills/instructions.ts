import { createHash } from 'node:crypto'
import { MAX_AGENT_INSTRUCTIONS_BYTES, type AgentConfigurationVersion, type AssignedSkill, type ResolvedSkill } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../harnesses/errors.js'

/** Board Agent and application-level Operator configurations share one composition rule. */
interface InstructionSource {
  prompt?: AgentConfigurationVersion['prompt'] | undefined
  assignedSkills?: readonly (AssignedSkill & { workspaceId?: string })[] | undefined
  resolvedSkills?: readonly ResolvedSkill[] | undefined
}

/** The app-owned instructions a native session receives, separate from task input. */
export interface AgentInstructionBundle {
  delivery: 'native-v1'
  text: string
  /** Identity of the exact text, for correlation and duplicate-delivery checks. */
  hash: string
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

/** Never resolve a mutable catalog from a running execution or silently drop missing content. */
export function verifiedSkills(configuration: InstructionSource): ResolvedSkill[] {
  const references = configuration.assignedSkills ?? []
  const snapshots = configuration.resolvedSkills ?? []
  if (!references.length && !snapshots.length) return []
  if (references.length !== snapshots.length || new Set(references.map((item) => JSON.stringify([item.workspaceId, item.skillId]))).size !== references.length) {
    throw new HarnessExecutionError('SKILL_SNAPSHOT_MISSING', 'Republish the Agent configuration with validated skill versions before running it.')
  }
  return references.map((reference, index) => {
    const skill = snapshots[index]
    if (!skill || skill.skillId !== reference.skillId || skill.version !== reference.version
      || (skill.workspaceId !== undefined && skill.workspaceId !== reference.workspaceId) || skill.contentHash !== sha256(skill.instructions)) {
      throw new HarnessExecutionError('SKILL_SNAPSHOT_INVALID', 'The accepted skill snapshot failed its identity/integrity check.')
    }
    return skill
  })
}

export function composeInstructionText(configuration: InstructionSource): string {
  const sections = configuration.prompt?.system ? [configuration.prompt.system] : []
  for (const skill of verifiedSkills(configuration)) {
    sections.push(`# Skill: ${skill.name ?? skill.skillId} (${skill.skillId}@${skill.version})\n\n${skill.instructions}`)
  }
  return sections.join('\n\n')
}

export function instructionsTooLarge(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > MAX_AGENT_INSTRUCTIONS_BYTES
}

/** Persistent Agent instructions followed by full pinned skill bodies in saved order.
 * Undefined for configurations accepted before native delivery, or with nothing to deliver. */
export function agentInstructionBundle(configuration: InstructionSource & Pick<AgentConfigurationVersion, 'instructionDelivery'>): AgentInstructionBundle | undefined {
  if (configuration.instructionDelivery !== 'native-v1') return undefined
  const text = composeInstructionText(configuration)
  if (!text) return undefined
  if (instructionsTooLarge(text)) {
    throw new HarnessExecutionError('AGENT_INSTRUCTIONS_TOO_LARGE', `Agent instructions and skills exceed ${MAX_AGENT_INSTRUCTIONS_BYTES / 1024} KiB. Remove skills or shorten them.`)
  }
  return { delivery: 'native-v1', text, hash: sha256(text) }
}

/** Configurations accepted before native delivery keep their in-task sections. */
export function legacySkillPrompt(configuration: InstructionSource): string[] {
  return verifiedSkills(configuration).flatMap((skill) => [`ASSIGNED SKILL ${skill.skillId}@${skill.version}`, skill.instructions, ''])
}
