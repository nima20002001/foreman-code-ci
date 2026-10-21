import { create } from 'zustand'
import { createNextDraftSlice, type NextDraftSlice } from './nextDraft/state'
import { clearEditIntentStorage } from './nextDraft/editIntentStorage'
import { clearBoardStartStorage } from '../workflow-board/startOutbox'
import { clearBoardStopStorage } from '../workflow-board/stopOutbox'
import { clearCurrentLayoutJournals } from './nextDraft/useDraftLayout'

/** Local authoring and interaction only. Requests and Run facts belong to Query. */
export const useGraphDraftStore = create<NextDraftSlice & { clearAllDrafts(): void }>((set) => ({
  ...createNextDraftSlice(set),
  clearAllDrafts: () => {
    clearBoardStartStorage(); clearBoardStopStorage(); clearEditIntentStorage(); clearCurrentLayoutJournals()
    set({ nextDrafts: {} })
  },
}))
