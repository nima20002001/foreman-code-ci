import type pg from 'pg'
import { AgentChatStateSchema, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { NativeConversationControlCommands } from './nativeControlCommands.js'

/** Existing Agent namespace; controls remain distinct from model-turn receipts. */
export class AgentChatCommands extends NativeConversationControlCommands<AgentChatState> {
  constructor(pool: Pick<pg.Pool, 'query'>) {
    super(pool, { operation: 'agent_chat_control', parse: (value) => AgentChatStateSchema.parse(value),
      prefix: 'AGENT_CHAT', label: 'Agent chat' })
  }
}
