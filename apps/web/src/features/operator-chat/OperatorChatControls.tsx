import type { OperatorConversationState, SessionMode } from '@foreman-code/contracts'
import { Alert, Button } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { ChatAttachmentControl } from '../attachments'
import { CompactionActivity } from '../conversations/sessionControls/CompactionActivity'
import type { ComposerSessionControls } from '../conversations/sessionControls/useSessionControls'
import { SettingsFormFeedback } from '../settings/SettingsFormActions'
import type { useFileDrop } from '../../shared/ui/useFileDrop'
import { OperatorAccessPicker } from './OperatorAccessPicker'
import { OperatorComposer } from './OperatorComposer'
import { OperatorComposerSettings } from './OperatorComposerSettings'
import type { deriveOperatorMessaging } from './operatorChatDerived'
import type { readPendingOperatorMessage } from './operatorOutbox'
import type { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'
import type { useOperatorChatAttachments } from './useOperatorChatAttachments'
import type { useOperatorConversationMutations } from './useOperatorConversationMutations'
import type { useOperatorSendMutation } from './useOperatorSendMutation'
import type { useOperatorSettings } from './useOperatorSettings'

/** Retired-harness notice or the settings, status and composer footer. */
export function OperatorChatControls({ conversation, retired, settings, preferences, preferencesDenied, pending, preparing, attachments,
  attachmentReceipts, attachmentReceiptPending, attachmentsDisabled, fileDrop, pendingHandoff, turnStatus, connectionState, sessionControls,
  setupReady, settingsReady, archived, active, send, cancel, requestId, selectedId, createConversation, submit }: {
  conversation: OperatorConversationState
  retired: boolean
  settings: ReturnType<typeof deriveOperatorMessaging>['settings']
  preferences: ReturnType<typeof useOperatorSettings>
  preferencesDenied: boolean
  pending: ReturnType<typeof readPendingOperatorMessage>
  preparing: boolean
  attachments: ReturnType<typeof useOperatorChatAttachments>['attachments']
  attachmentReceipts: ReturnType<typeof useOperatorAttachmentReceipts>
  attachmentReceiptPending: boolean
  attachmentsDisabled: boolean
  fileDrop: ReturnType<typeof useFileDrop>
  pendingHandoff: boolean
  turnStatus: string
  connectionState: string
  sessionControls: ComposerSessionControls
  setupReady: boolean
  settingsReady: boolean
  archived: boolean
  active: boolean
  send: ReturnType<typeof useOperatorSendMutation>
  cancel: ReturnType<typeof useOperatorConversationMutations>['cancel']
  requestId: string | null | undefined
  selectedId: string | undefined
  createConversation: () => Promise<void>
  submit: (content: string, sessionMode?: SessionMode) => Promise<void>
}) {
  if (retired) return <p role="status">Retired harness (OpenCode): read-only</p>
  return <footer className="operator-chat-controls">
    {attachmentReceiptPending && !pending.command ? <Button size="sm" onClick={attachmentReceipts.reconcile}>Check previous message</Button> : null}
    {pendingHandoff ? <p className="operator-chat-handoff" role="status">{attachments.hasAttachments ? 'Files stay in this chat. Start a new chat to attach files.' : <>Your next message starts {settings!.harness === 'claude' ? 'a Claude' : 'a Codex'} chat with prior conversation context.</>}</p> : null}
    {preferences.query.isError ? <Alert tone={preferencesDenied ? 'danger' : 'warning'} title={preferencesDenied ? 'Operator settings access unavailable' : 'Could not refresh Operator settings'}
      action={<Button size="sm" onClick={() => void preferences.query.refetch()}>Retry settings</Button>}>
      {preferencesDenied ? 'Check your browser enrollment and permissions.' : preferences.query.data ? 'Last saved settings are still available.' : preferences.query.error.message}
    </Alert> : null}
    {preferences.form.isSaving ? <p role="status">Saving Operator settings…</p> : null}
    {!preferences.form.isSaving && (preferences.form.isDirty || preferences.form.error || preferences.form.conflicted || preferences.form.uncertain) ? <div>
      <SettingsFormFeedback form={preferences.form} />
      <Button size="sm" disabled={preferences.form.isSaving || (preferences.form.conflicted && !preferences.form.uncertain)} onClick={() => void preferences.save()}>Retry settings save</Button>
      {!preferences.form.uncertain ? <Button size="sm" disabled={preferences.form.isSaving} onClick={preferences.form.reset}>Discard settings changes</Button> : null}
    </div> : null}
    {turnStatus && (conversation.messages.length > 0 || conversation.hasEarlierMessages || conversation.activeRequestId || conversation.turnState !== 'idle' || connectionState !== 'connected') ? <div className="operator-chat-turn-actions">
      <p role="status">{turnStatus}</p>
    </div> : null}
    <CompactionActivity controls={sessionControls} />
    <OperatorComposer sessionControls={sessionControls} key={conversation.conversation.id} context={settings ? <OperatorComposerSettings value={settings} disabled={Boolean(pending.command) || preparing || preferences.form.isSaving || preferences.form.uncertain || preferences.query.isError}
      onChange={preferences.change}
      access={preferences.harness ? <OperatorAccessPicker key={preferences.harness.harness} value={preferences.harness} disabled={Boolean(pending.command) || preparing || preferences.form.isSaving || preferences.form.uncertain || preferences.query.isError}
        saving={preferences.form.isSaving} saveError={preferences.form.error}
        onChange={preferences.changeAccess} /> : undefined} /> : undefined}
      hasAttachments={attachments.hasAttachments}
      fileDropProps={fileDrop.dropTargetProps}
      attachmentControl={<ChatAttachmentControl draft={attachments} disabled={attachmentsDisabled} composerDrop={fileDrop} />}
      onNewChat={() => void createConversation()} conversationId={conversation.conversation.id}
      sendDisabled={attachmentReceiptPending || attachments.hasBlockingAttachments || (attachments.hasAttachments && pendingHandoff) || !setupReady || !settingsReady || archived || active || preparing || Boolean(pending.error) || Boolean(pending.command)}
      isSending={preparing || (send.isPending && send.variables?.id === selectedId)} onSubmit={submit}
      onCancel={requestId && conversation.turnState !== 'canceling' ? () => cancel.mutate({ id: conversation.conversation.id, requestId, generation: sessionGeneration() }) : undefined} />
  </footer>
}
