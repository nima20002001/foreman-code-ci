import { useQueryClient } from '@tanstack/react-query'
import { beginSessionChange, bindDocumentInstallation, documentInstallationId, sessionSignal } from '../shared/api/sessionBoundary'
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRuntimeIdentityQuery, useRuntimeInstallationId, useRuntimeBuildIdentityQuery } from '../shared/api/runtimeIdentity'
import { documentBuildIdentity } from '../shared/api/documentBuildIdentity'
import { bindProtectedChatInstance } from '../shared/api/protectedChatStorage'
import { Button } from '../shared/ui/nocturne'
import { UnsavedChangesContext } from '../shared/ui/unsavedChanges'
import './runtimeBoundary.css'

/** Check installation ownership before document-scoped drafts or outbox can render. */
export function RuntimeInstanceBoundary({ children }: { children: ReactNode }) {
  const identity = useRuntimeIdentityQuery()
  const build = useRuntimeBuildIdentityQuery(true)
  const client = useQueryClient()
  const installationId = useRuntimeInstallationId()
  const current = installationId ? `installation:${installationId}` : undefined
  const [accepted, setAccepted] = useState<string>()
  const [storageFailed, setStorageFailed] = useState(false)
  const reloading = useRef(false)
  const updated = Boolean(build.data && build.data.buildId !== documentBuildIdentity.buildId)
  const reconnecting = identity.failureCount > 0 && !identity.isError || build.failureCount > 0 && !build.isError
  const signal = sessionSignal()
  useEffect(() => {
    const clear = () => client.clear()
    signal.addEventListener('abort', clear, { once: true })
    return () => signal.removeEventListener('abort', clear)
  }, [client, signal])
  useEffect(() => {
    if (!current || !build.data || identity.isError || build.isError || reloading.current || storageFailed) return
    // An initial mismatch has no mounted editors. Never learn the document's build from its first API response.
    if (!accepted && updated) {
      reloading.current = true
      window.location.reload()
      return
    }
    if (current === accepted && documentInstallationId() === installationId) return
    const installationChanged = Boolean(accepted && current !== accepted)
    if (installationChanged) beginSessionChange()
    try {
      const storageNeedsReload = bindProtectedChatInstance(current)
      if (storageNeedsReload || installationChanged || !bindDocumentInstallation(installationId!)) {
        reloading.current = true
        if (!installationChanged) beginSessionChange()
        window.location.reload()
      } else setAccepted(current)
    } catch { setStorageFailed(true) }
  }, [current, installationId, identity.isError, build.data, build.isError, accepted, updated, storageFailed])
  if (identity.isError || build.isError && !build.data || storageFailed) return <main className="runtime-screen"><section className="runtime-card" role="alert">
    <h1>Could not verify this app</h1>
    <p>{storageFailed ? 'Browser storage is unavailable. Allow storage for this app, then try again.'
      : 'The app connection could not be verified.'}</p>
    <Button variant="primary" onClick={() => { setStorageFailed(false); void identity.refetch(); void build.refetch() }}>Try again</Button>
  </section></main>
  if (!current || !build.data || current !== accepted || reloading.current) {
    return <main className="runtime-screen" role="status">
      {reconnecting ? 'Reconnecting…' : 'Connecting to this app…'}
    </main>
  }
  return <>
    {reconnecting && <div className="runtime-reconnecting" role="status">Reconnecting…</div>}
    {updated && <div className="runtime-reconnecting" role="status">App updated. Your pending changes are kept until it can reload.</div>}
    {children}
  </>
}

/** After a release, reload silently once no editor holds unsaved or pending changes. */
export function ReleaseAutoReload() {
  const build = useRuntimeBuildIdentityQuery()
  const unsavedChanges = useContext(UnsavedChangesContext)
  const updated = Boolean(build.data && build.data.buildId !== documentBuildIdentity.buildId)
  useEffect(() => {
    if (!updated) return
    const reloadWhenClean = () => {
      if (unsavedChanges?.unsaved?.()) return false
      window.location.reload()
      return true
    }
    if (reloadWhenClean()) return
    const timer = window.setInterval(() => { if (reloadWhenClean()) window.clearInterval(timer) }, 5_000)
    return () => window.clearInterval(timer)
  }, [updated, unsavedChanges])
  return null
}
