import type { OperatorConversationState } from '@foreman-code/contracts'
import { Alert, Button } from '../../shared/ui/nocturne'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { ChatAttachmentControl } from '../attachments'
import { CompactionActivity } from '../conversations/sessionControls/CompactionActivity'
import type { ComposerSessionControls } from '../conversations/sessionControls/useSessionControls'
import { SettingsFormFeedback } from '../settings/SettingsFormActions'
import type { useFileDrop } from '../../shared/ui/useFileDrop'
import { OperatorAccessPicker } from './OperatorAccessPicker'
import { CanonicalOperatorComposer } from './CanonicalOperatorComposer'
import { OperatorComposerSettings } from './OperatorComposerSettings'
import type { deriveOperatorMessaging } from './operatorChatDerived'
import type { readPendingOperatorMessage } from './operatorOutbox'
import type { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'
import type { useOperatorChatAttachments } from './useOperatorChatAttachments'
import type { useOperatorSettings } from './useOperatorSettings'

/** Retired-harness notice or the settings, status and composer footer. */
export function OperatorChatControls({ conversation, retired, settings, preferences, preferencesDenied, pending, preparing, attachments,
  attachmentReceipts, attachmentReceiptPending, attachmentsDisabled, fileDrop, pendingHandoff, turnStatus, connectionState, sessionControls,
  setupReady, settingsReady, archived, active, createConversation, canonical }: {
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
  createConversation: () => Promise<void>
  canonical: { onDenied(error: Error): void; refresh(): void }
}) {
  if (retired) return <p role="status">Retired harness (OpenCode): read-only</p>
  return <footer className="operator-chat-controls">
    {attachmentReceiptPending && !pending.command ? <Button size="sm" onClick={attachmentReceipts.reconcile}>Check previous message</Button> : null}
    {pendingHandoff ? <p className="operator-chat-handoff" role="status">Changed Operator settings apply to a new chat. This draft stays with the selected conversation.</p> : null}
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
    <CanonicalOperatorComposer key={`${identityEpoch()}:${conversation.conversation.id}`} conversation={conversation}
      attachments={attachments} sessionControls={sessionControls} fileDropProps={fileDrop.dropTargetProps}
      attachmentControl={<ChatAttachmentControl draft={attachments} disabled={attachmentsDisabled} composerDrop={fileDrop} />}
      context={settings ? <OperatorComposerSettings futureChats value={settings} disabled={active || !!pending.command || attachmentReceiptPending || preparing || preferences.form.isSaving || preferences.form.uncertain || preferences.query.isError}
        onChange={preferences.change} access={preferences.harness ? <OperatorAccessPicker key={preferences.harness.harness}
          value={preferences.harness} disabled={active || !!pending.command || attachmentReceiptPending || preferences.form.isSaving || preferences.form.uncertain || preferences.query.isError}
          saving={preferences.form.isSaving} saveError={preferences.form.error} onChange={preferences.changeAccess} /> : undefined} /> : undefined}
      reason={archived ? 'This chat is archived.' : pendingHandoff ? 'Start a new chat to use the changed Operator settings.'
        : !setupReady || !settingsReady ? 'Finish Operator setup and save settings before sending.'
          : attachmentReceiptPending || pending.command || pending.error ? 'Confirm the previous message before sending.' : undefined}
      onNewChat={() => void createConversation()} onDenied={canonical.onDenied} refresh={canonical.refresh} />
  </footer>
}
