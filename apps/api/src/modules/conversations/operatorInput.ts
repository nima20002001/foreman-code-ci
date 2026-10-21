import type { SendOperatorMessageRequest } from '@foreman-code/contracts'
import { sessionTaskContent } from '@foreman-code/contracts'
import type { ConversationRow } from './operatorChatRepository.js'
import { publicOperatorConversation } from './operatorConversationRecord.js'
import { nativeChatPrompt } from './nativeChatInput.js'

/** The admission preflight and native dispatch use the same composition. */
export function operatorMessagePrompt(row: ConversationRow, input: SendOperatorMessageRequest,
  initial: boolean, handoff: boolean): string {
  const user = nativeChatPrompt(sessionTaskContent(input.content, input.sessionMode), Boolean(input.attachments?.length))
  const initialPrompt = initial ? publicOperatorConversation(row.record).initialPrompt?.value.text : undefined
  const preamble = [initialPrompt, handoff ? row.handoff_context : undefined].filter(Boolean).join('\n\n')
  const hint = input.context && Object.values(input.context).some(Boolean)
    ? `\n\n[Non-authoritative route context: ${JSON.stringify(input.context)}]` : ''
  return `${preamble ? `${preamble}\n\nCurrent user message:\n` : ''}${user}${hint}`
}
