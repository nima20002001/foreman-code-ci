import { useQuery } from '@tanstack/react-query'
import { BrowserControlSchema, BrowserSessionSchema, BrowserTabLeaseSchema } from '@foreman-code/contracts/browser-sessions'
import { ownsTab, sameSubject, subjectKey } from './identity'
import type { BrowserSelection, BrowserSessionRead, BrowserUiPort } from './types'

export const browserSessionKey = (selection: BrowserSelection) => ['browser', selection.authBoundary,
  ...subjectKey(selection.subject), selection.visitKey, selection.sessionId] as const

export function validateBrowserRead(read: BrowserSessionRead, selection?: BrowserSelection): BrowserSessionRead {
  const session = BrowserSessionSchema.parse(read.session)
  const control = BrowserControlSchema.parse(read.control)
  const tabs = read.tabs.map(tab => BrowserTabLeaseSchema.parse(tab))
  if (control.sessionId !== session.id || tabs.some(tab => !ownsTab(session, tab))
    || new Set(tabs.map(tab => tab.tabId)).size !== tabs.length
    || (selection && (session.id !== selection.sessionId || !session.subject || !sameSubject(session.subject, selection.subject)))) {
    throw new Error('The browser response does not match the selected agent session.')
  }
  if ((read.uploadChooser && !tabs.some(tab => tab.tabId === read.uploadChooser!.tabId))
    || (read.dialog && !tabs.some(tab => tab.tabId === read.dialog!.tabId))) {
    throw new Error('The browser action belongs to an unavailable tab.')
  }
  return { session, control, tabs, uploadChooser: read.uploadChooser, files: read.files, dialog: read.dialog }
}

export function useBrowserSession(port: BrowserUiPort, selection: BrowserSelection) {
  return useQuery({ queryKey: browserSessionKey(selection),
    enabled: selection.enabled && selection.sessionId !== null,
    queryFn: async ({ signal }) => validateBrowserRead(await port.readSession(selection.sessionId!, signal), selection),
    retry: false, staleTime: 0, refetchOnWindowFocus: false,
    refetchInterval: query => query.state.data && !['closed', 'failed'].includes(query.state.data.session.state) ? 1500 : false,
    refetchIntervalInBackground: false })
}

export function useBrowserSessions(port: BrowserUiPort, selection: BrowserSelection) {
  return useQuery({ queryKey: ['browser', selection.authBoundary, ...subjectKey(selection.subject), selection.visitKey, 'sessions'],
    enabled: selection.enabled && !selection.sessionId,
    queryFn: async ({ signal }) => {
      const sessions = (await port.listSessions(selection.subject, signal)).map(session => BrowserSessionSchema.parse(session))
      if (sessions.some(session => !session.subject || !sameSubject(session.subject, selection.subject))) {
        throw new Error('The browser list contains a different agent session.')
      }
      return sessions
    }, retry: false, staleTime: 0, refetchOnWindowFocus: false })
}
