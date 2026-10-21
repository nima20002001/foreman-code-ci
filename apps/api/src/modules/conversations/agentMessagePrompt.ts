import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { AgentConversationRow } from './agentChatRepository.js'
import { legacySkillPrompt } from '../skills/instructions.js'

/** Used by admission and dispatch so saved startup/handoff text has the same byte budget. */
export function agentMessagePrompt(record: AgentConversationRow['record'],
  configuration: AgentConfigurationVersion, content: string): { text: string; startup: boolean } {
  if (record.handoffContext && !record.startupDelivered) content = `${record.handoffContext}\n\n${content}`
  if (record.origin.kind !== 'fresh' || record.startupDelivered) return { text: content, startup: false }
  if (configuration.instructionDelivery === 'native-v1') return { text: content, startup: true }
  const skills = legacySkillPrompt(configuration)
  if (!skills.length) return { text: content, startup: true }
  return { text: [...skills, '', 'USER MESSAGE', content].join('\n'), startup: true }
}
