import type { OperatorChatSetupQuery, SendOperatorMessageRequest } from '@foreman-code/contracts'

/** Pending operations never inherit a newer shared selection or defaults revision. */
export function pendingOperatorSetupTarget(conversationId: string | undefined,
  command: SendOperatorMessageRequest | undefined): OperatorChatSetupQuery {
  return { ...(conversationId ? { conversationId } : {}),
    ...(command ? { requestId: command.requestId } : {}),
    ...(command?.settings ? { harness: command.settings.harness } : {}),
    ...(command?.defaultsRevision === undefined ? {} : { expectedDefaultsRevision: command.defaultsRevision }),
    ...(command?.configurationVersionId ? { configurationVersionId: command.configurationVersionId } : {}) }
}
