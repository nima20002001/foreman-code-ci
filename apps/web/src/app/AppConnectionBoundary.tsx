import { type ReactNode } from 'react'
import { useLocalHumanAccessQuery } from '../shared/api/settingsExperience'
import { ApiError } from '../shared/api/client'
import { Button } from '../shared/ui/nocturne'
import { isTransientReadError, useBlockingReadError } from '../shared/api/readFailure'
import { reconnectingMessage, useApiReconnect } from '../shared/api/reconnect'
import { RuntimeInstanceBoundary } from './RuntimeInstanceBoundary'
import { ChatAttachmentBoundary } from '../features/conversations/ChatAttachmentBoundary'
import './runtimeBoundary.css'

export function AppConnectionBoundary({ children }: { children: ReactNode }) {
  const access = useLocalHumanAccessQuery()
  const reconnecting = useApiReconnect()
  const blocked = useBlockingReadError(access)
  const denied = ApiError.is(access.error) && [401, 403].includes(access.error.status ?? 0)
  const retryableLookup = isTransientReadError(access.error)
  const unavailable = <main className="runtime-screen"><section className="runtime-card" role="alert">
    <h1>{denied ? 'Access unavailable' : 'Cannot reach the server'}</h1>
    <p>{access.error?.message ?? 'Check the local API connection, then try again.'}</p>
    <Button variant="primary" onClick={() => void access.refetch()}>Try again</Button>
  </section></main>
  if (!blocked && reconnecting && !access.data) return <main className="runtime-screen">
    <section className="runtime-card" role="status">
      <p>{reconnectingMessage}</p>
      <Button variant="primary" onClick={() => void access.refetch()}>Try again</Button>
    </section>
  </main>
  if (blocked || access.isError && !access.data) return unavailable
  if (!access.data) return <main className="runtime-screen" role="status">Connecting to the local app…</main>
  return <RuntimeInstanceBoundary><ChatAttachmentBoundary>
    {access.isError && !retryableLookup ? unavailable : <>
      {reconnecting || retryableLookup ? <aside className="runtime-reconnecting" aria-label="Server connection" role="alert">
        <span>{reconnecting ? reconnectingMessage : 'Connection interrupted.'}</span>
        <Button size="sm" data-skip-folder-blur onClick={() => void access.refetch()}
          loading={access.isFetching}>Try again</Button>
      </aside> : null}
      {children}
    </>}
  </ChatAttachmentBoundary></RuntimeInstanceBoundary>
}
