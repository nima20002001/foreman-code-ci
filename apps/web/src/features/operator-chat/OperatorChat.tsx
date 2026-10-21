import { useId, useRef, useState } from 'react'
import { useSessionControls } from '../conversations/sessionControls/useSessionControls'
import { useFileDrop } from '../../shared/ui/useFileDrop'
import { ChatAttachmentBoundary } from '../conversations/ChatAttachmentBoundary'
import { UnavailableChatDraft } from '../conversations/delivery/UnavailableChatDraft'
import { Alert, Button } from '../../shared/ui/nocturne'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { isNarrowOperatorChat, useOperatorChatStore } from './operatorChatStore'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import { useOperatorSettings } from './useOperatorSettings'
import { useAskOperatorRequest } from './useAskOperatorRequest'
import { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'
import { useOperatorChatAttachments } from './useOperatorChatAttachments'
import { useOperatorChatReadback } from './useOperatorChatReadback'
import { useOperatorChatShellEffects } from './useOperatorChatShellEffects'
import { useOperatorChatStream } from './useOperatorChatStream'
import { useOperatorConversationMutations } from './useOperatorConversationMutations'
import { useOperatorCreateConversation } from './useOperatorCreateConversation'
import { useOperatorSendMutation } from './useOperatorSendMutation'
import { useOperatorSetupState } from './useOperatorSetupState'
import { useOperatorSubmit } from './useOperatorSubmit'
import { deriveOperatorLiveText, deriveOperatorMessaging, deriveOperatorNavigation } from './operatorChatDerived'
import type { AskSend, ConnectionState, PartialState, PreparationError } from './operatorChatShared'
import { useProviderAccounts } from '../provider-accounts/providerAccountsQueries'
import { OperatorChatControls } from './OperatorChatControls'
import { OperatorChatHeader } from './OperatorChatHeader'
import { OperatorChatHistory } from './OperatorChatHistory'
import { OperatorChatLauncher } from './OperatorChatLauncher'
import { OperatorChatNotices } from './OperatorChatNotices'
import { OperatorConversationTranscript } from './OperatorConversationTranscript'
import { OperatorDecisionArea } from './OperatorDecisionArea'
import { operatorResizeEdges, useOperatorChatResize } from './useOperatorChatResize'
import './operatorChat.css'

export function OperatorChat(props: { settingsWarning?: string } = {}) {
  return <ChatAttachmentBoundary><OperatorChatContent {...props} /></ChatAttachmentBoundary>
}

function OperatorChatContent({ settingsWarning }: { settingsWarning?: string }) {
  const enabled = useOperatorChatVisibility()
  const attachmentReceipts = useOperatorAttachmentReceipts()
  const { panelRef, size, grip, moveGrip } = useOperatorChatResize()
  const [removed, setRemoved] = useState<{ id: string; title: string }>()
  const [handoffNotice, setHandoffNotice] = useState<{ id: string; epoch: string }>()
  const [closing, setClosing] = useState(false)
  const [askSend, setAskSend] = useState<AskSend>()
  const open = useOperatorChatStore((state) => state.open)
  const historyOpen = useOperatorChatStore((state) => state.historyOpen)
  const selectedId = useOperatorChatStore((state) => state.selectedConversationId)
  const accounts = useProviderAccounts(enabled && open)
  const sessionControls = useSessionControls(selectedId ?? undefined, { enabled: enabled && open })
  const preferences = useOperatorSettings(enabled && open)
  const preferencesDenied = useAccessFailureLatch(preferences.query)
  const setOpen = useOperatorChatStore((state) => state.setOpen)
  const setHistoryOpen = useOperatorChatStore((state) => state.setHistoryOpen)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<HTMLElement>(null)
  const panelId = useId()
  const historyId = useId()
  // Presentation-only fragments. Query/PostgreSQL still own all finalized state.
  const [partial, setPartial] = useState<PartialState>()
  const [preparationError, setPreparationError] = useState<PreparationError>()
  const [connection, setConnection] = useState<ConnectionState>()
  const [, refreshOutbox] = useState(0)
  const [preparingId, setPreparingId] = useState<string>()
  const [deniedConversation, setDeniedConversation] = useState<string>()
  const { list, selected, accessDenied, acceptState, invalidate, loadOlderChats, deletedRevisions, readGeneration } = useOperatorChatReadback(enabled, open, selectedId, !!selectedId && deniedConversation === selectedId)
  const { attachments, attachmentReceiptPending } = useOperatorChatAttachments({ enabled: enabled && open, selectedId, accessDenied, selectedData: selected.data, attachmentReceipts })
  const { pending, setup, shownSetup, missingSelection, recoveredSelection } = useOperatorSetupState({
    enabled, open, selectedId, accessDenied, selectedError: selected.error, preferences, preferencesDenied })
  const { create, creating, createConversation } = useOperatorCreateConversation({
    historyTriggerRef, setAskSend, setup, preferences, accessDenied, selectedId })
  const send = useOperatorSendMutation({ acceptState, invalidate, attachmentReceipts, setPreparationError, setHandoffNotice, refreshOutbox })
  const { cancel, respond, remove, restore } = useOperatorConversationMutations({ acceptState, invalidate, deletedRevisions, setRemoved })
  useOperatorChatShellEffects({ enabled, open, closing, setClosing, closeRef, launcherRef, refreshOutbox })
  useOperatorChatStream({ enabled, open, selectedId, accessDenied, acceptState, readGeneration, setPartial, setConnection })

  const conversation = accessDenied ? undefined : selected.data
  const active = Boolean(conversation && (conversation.activeRequestId || !['idle', 'error'].includes(conversation.turnState)))
  const archived = conversation?.conversation.status === 'archived'
  const preparing = preparingId === selectedId
  const attachmentsDisabled = Boolean(archived || pending.command) || preparing
  const fileDrop = useFileDrop({ disabled: attachmentsDisabled || !attachments.canAdd, onFiles: attachments.addFiles })
  const { settings, retired, messageSettings, pendingHandoff, setupReady, settingsReady } = deriveOperatorMessaging({
    conversation, preferences, preferencesDenied, accounts, setup })
  const requestId = conversation?.activeRequestId ?? conversation?.pendingInteraction?.turn.nativeRequestId
  const scopedSendError = send.variables?.id === selectedId && send.variables?.command.requestId === pending.command?.requestId
    && send.error instanceof Error ? send.error.message : undefined
  const sendError = preparationError && preparationError.id === selectedId ? preparationError.message
    : scopedSendError ?? pending.sendFailure
  const { partialText, thinkingText } = deriveOperatorLiveText({ conversation, partial, selectedId, requestId })
  const { entries, attention, connectionState, turnStatus } = deriveOperatorNavigation({
    accessDenied, listData: list.data, conversation, deletedRevisions, connection, selectedId, selected })
  const submit = useOperatorSubmit({ selectedId, setupReady, settingsReady, archived, active, accessDenied, pending, attachmentReceiptPending,
    send, attachments, attachmentReceipts, pendingHandoff, setPreparationError, setPreparingId, refreshOutbox, messageSettings,
    conversation, preferences, createConversation })
  const askReady = setupReady && settingsReady && conversation?.conversation.id === selectedId && !active && !archived
    && !pending.command && !pending.error && !attachmentReceiptPending
  const request = useAskOperatorRequest({ enabled, open, accessDenied, create, creating, askSend, setAskSend, selectedId, askReady, submit })
  const close = () => {
    setClosing(true)
    setOpen(false)
  }
  const showHistory = (next: boolean) => {
    setHistoryOpen(next)
    window.requestAnimationFrame(() => {
      if (next) historyRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      else historyTriggerRef.current?.focus()
    })
  }
  if (!enabled || sessionIsSwitching()) return null
  return <div className="operator-chat-root">
    {open || closing ? <section ref={panelRef} style={size} id={panelId} className="operator-chat" data-state={open ? 'open' : 'closing'} role="dialog" aria-modal={false} aria-label="Operator chat" aria-hidden={closing} inert={closing}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopPropagation()
        if (historyOpen && isNarrowOperatorChat()) showHistory(false)
        else close()
      }}>
      {operatorResizeEdges.map((edge) => <button key={edge} type="button" className={`operator-chat-resize operator-chat-resize-${edge}`} {...grip(edge)} />)}
      {settingsWarning ? <details><summary>Operator settings refresh failed</summary>{settingsWarning}</details> : null}
      {accessDenied ? <Alert live tone="danger" title="Operator access unavailable"
        action={<Button size="sm" onClick={() => { setDeniedConversation(undefined); void list.refetch(); void selected.refetch() }}>Refresh access</Button>}>Check your browser enrollment and permissions.</Alert> : null}
      <OperatorChatHeader historyOpen={historyOpen} historyId={historyId} historyTriggerRef={historyTriggerRef} closeRef={closeRef}
        historyFailed={list.isError} moveGrip={moveGrip}
        sessionControls={conversation ? sessionControls : undefined} accountBinding={conversation && !retired ? conversation.providerAccountBinding : undefined} onToggleHistory={() => showHistory(!historyOpen)} onClose={close} />
      <div className={`operator-chat-body${historyOpen ? ' operator-chat-history-open' : ''}`}>
        <OperatorChatHistory historyOpen={historyOpen} historyId={historyId} historyRef={historyRef} historyTriggerRef={historyTriggerRef}
          list={list} entries={entries} selectedId={selectedId} accessDenied={accessDenied} creating={create.isPending}
          onNewChat={() => void createConversation()} loadOlderChats={loadOlderChats} remove={remove} />
        <main className="operator-chat-main">
          <OperatorChatNotices handoffNotice={handoffNotice} setHandoffNotice={setHandoffNotice} recoveredSelection={recoveredSelection}
            missingSelection={missingSelection} shownSetup={shownSetup} remove={remove} restore={restore} create={create} request={request}
            accessDenied={accessDenied} createConversation={createConversation} selectedId={selectedId} selected={selected} conversation={conversation} />
          {conversation ? <>
            <OperatorConversationTranscript conversation={conversation} retired={retired} archived={archived} requestId={requestId}
              selectedId={selectedId} partial={partial} partialText={partialText} thinkingText={thinkingText} selected={selected} respond={respond} />
            <OperatorDecisionArea conversation={conversation} selectedId={selectedId} requestId={requestId} retired={retired} pending={pending}
              sendError={sendError} send={send} respond={respond} cancel={cancel} attachmentReceipts={attachmentReceipts}
              setPreparationError={setPreparationError} refreshOutbox={refreshOutbox} />
            <OperatorChatControls conversation={conversation} retired={retired} settings={settings} preferences={preferences}
              preferencesDenied={preferencesDenied} pending={pending} preparing={preparing} attachments={attachments}
              attachmentReceipts={attachmentReceipts} attachmentReceiptPending={attachmentReceiptPending} attachmentsDisabled={attachmentsDisabled}
              fileDrop={fileDrop} pendingHandoff={pendingHandoff} turnStatus={turnStatus} connectionState={connectionState}
              sessionControls={sessionControls} setupReady={setupReady} settingsReady={settingsReady} archived={archived} active={active}
              createConversation={createConversation}
              canonical={{ refresh: () => { if (selectedId) void invalidate(selectedId) },
                onDenied: () => { setPartial(undefined); setDeniedConversation(selectedId) } }} />
          </> : selectedId && !accessDenied ? <UnavailableChatDraft draftKey={selectedId} pending={selected.isPending}
            onRefresh={() => void selected.refetch()} /> : null}
        </main>
      </div>
      {removed ? <div className="operator-chat-undo" role="status">Chat deleted. <Button size="sm" variant="ghost" disabled={restore.isPending}
        onClick={() => restore.mutate({ id: removed.id, generation: sessionGeneration(),
          navigationGeneration: useOperatorChatStore.getState().beginNavigation() })}>Undo</Button></div> : null}
    </section> : null}
    <OperatorChatLauncher launcherRef={launcherRef} open={open} closing={closing} panelId={panelId} attention={attention}
      settingsWarning={settingsWarning} listFailed={list.isError} />
  </div>
}
