import type pg from 'pg'
import { OperatorConversationStateSchema, type OperatorConversationState } from '@foreman-code/contracts'
import { NativeConversationControlCommands } from './nativeControlCommands.js'

/** Shared autocommit reservation/settlement; no native effect occurs inside a database transaction. */
export class OperatorChatCommands extends NativeConversationControlCommands<OperatorConversationState> {
  constructor(pool: Pick<pg.Pool, 'query'>) {
    super(pool, { operation: 'operator_chat_control', parse: (value) => OperatorConversationStateSchema.parse(value),
      prefix: 'OPERATOR_CHAT', label: 'Operator chat' })
  }
}
