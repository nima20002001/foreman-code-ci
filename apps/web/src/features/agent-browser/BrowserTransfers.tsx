import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button, TextField } from '../../shared/ui/nocturne'
import { browserAccessDenied, browserErrorMessage } from './errors'
import { BrowserUpload, readBrowserDownload } from './transfers'
import type { BrowserFileLabel, BrowserFilesPort } from './transferTypes'
import type { BrowserSession, BrowserTabLease } from './types'

/** Exact owned chooser uploads and retained session downloads; no native paths leave the host. */
export function BrowserTransfers({ port, session, tab, uploadSelector, downloads, onChanged, acquire, onDenied }: {
  port: BrowserFilesPort; session: BrowserSession; tab?: BrowserTabLease; uploadSelector?: string
  acquire?(): Promise<{ viewerId: string; epoch: number }>
  onDenied?(error: unknown): void
  downloads: readonly BrowserFileLabel[]; onChanged(): void
}) {
  const upload = useRef<BrowserUpload | null>(null)
  const abort = useRef(new AbortController())
  const [progress, setProgress] = useState<number | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [fileInputKey, setFileInputKey] = useState(0)
  const lifecycle = useRef(0)
  const mounted = useRef(false)
  const send = useMutation({ mutationFn: async () => {
    if (!upload.current || !uploadSelector || !acquire) throw new Error('Choose a file for this browser upload.')
    const ready = await upload.current.send(abort.current.signal, setProgress)
    if (ready.state !== 'attached') {
      const control = await acquire()
      abort.current.signal.throwIfAborted()
      await upload.current.attach(uploadSelector, control)
    }
  }, retry: false, onSuccess: () => {
    upload.current = null
    if (mounted.current) { setFileInputKey(value => value + 1); onChanged() }
  } })
  useEffect(() => { if (browserAccessDenied(send.error)) onDenied?.(send.error) }, [send.error, onDenied])
  useEffect(() => {
    lifecycle.current += 1
    mounted.current = true
    return () => {
      mounted.current = false
      const retired = ++lifecycle.current
      queueMicrotask(() => {
        if (lifecycle.current !== retired) return
        abort.current.abort()
        void upload.current?.cancel().catch(error => console.warn('Browser upload cleanup remains pending:', browserErrorMessage(error)))
      })
    }
  }, [])
  const cancel = async () => {
    abort.current.abort()
    try {
      await upload.current?.cancel(); upload.current = null
      if (mounted.current) { setProgress(null); send.reset(); onChanged() }
    } catch (error) { if (mounted.current) setCancelError(browserErrorMessage(error)) }
  }
  return <section className="agent-browser-transfers" aria-label="Browser files">
    {uploadSelector && tab && acquire ? <>
      <TextField key={fileInputKey} type="file" label="Upload file" disabled={send.isPending || Boolean(upload.current)} onChange={event => {
        const file = event.currentTarget.files?.[0]
        if (!file) return
        abort.current = new AbortController(); upload.current = new BrowserUpload(port, session, tab, file)
        setCancelError(null); send.mutate()
      }} />
      {progress !== null ? <p role="status">{send.isSuccess ? 'File attached' : `${progress} bytes uploaded`}</p> : null}
      {send.error ? <p role="alert">{browserErrorMessage(send.error)} <Button onClick={() => send.mutate()}>Check original upload</Button></p> : null}
      {upload.current ? <Button size="sm" variant="ghost" disabled={send.isSuccess} onClick={() => { void cancel() }}>Cancel upload</Button> : null}
    </> : null}
    {cancelError ? <p role="alert">{cancelError}</p> : null}
    <ul aria-label="Downloads">{downloads.filter(file => file.purpose === 'download').map(file => <BrowserDownload key={file.id} port={port} session={session}
      file={file} onChanged={onChanged} onDenied={onDenied} />)}</ul>
  </section>
}

function BrowserDownload({ port, session, file, onChanged, onDenied }: {
  port: BrowserFilesPort; session: BrowserSession; file: BrowserFileLabel; onChanged(): void
  onDenied?(error: unknown): void
}) {
  const [commandId] = useState(() => crypto.randomUUID())
  const abort = useRef(new AbortController())
  const mounted = useRef(false)
  useEffect(() => {
    const lifetime = new AbortController()
    abort.current = lifetime
    mounted.current = true
    return () => { mounted.current = false; lifetime.abort() }
  }, [])
  const save = useMutation({ mutationFn: async () => {
    const signal = abort.current.signal
    const blob = await readBrowserDownload(port, session, file, signal)
    signal.throwIfAborted()
    if (!mounted.current) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = file.name; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }, retry: false })
  const remove = useMutation({ mutationFn: () => port.remove(session, file.id, commandId), retry: false,
    onSuccess: () => { if (mounted.current) onChanged() } })
  const failure = save.error ?? remove.error
  useEffect(() => { if (browserAccessDenied(failure)) onDenied?.(failure) }, [failure, onDenied])
  return <li><span>{file.name} · {file.byteLength} bytes · {file.state}</span>
    <Button size="sm" disabled={save.isPending || file.state !== 'ready'} onClick={() => save.mutate()}>Save file</Button>
    <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete file</Button>
    {save.error || remove.error ? <p role="alert">{browserErrorMessage(save.error ?? remove.error)}</p> : null}
  </li>
}
