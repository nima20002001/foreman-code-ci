import { useState } from 'react'
import { Button, TextField } from '../../shared/ui/nocturne'
import { BrowserTransfers } from './BrowserTransfers'
import type { BrowserFilesPort } from './transferTypes'
import type { BrowserSessionRead, BrowserTabLease } from './types'

export function BrowserSessionActions({ read, tab, files, disabled, readOnly, acquire, onRespond, onChanged, onDenied }: {
  read: BrowserSessionRead; tab: BrowserTabLease; files: BrowserFilesPort; disabled: boolean; readOnly: boolean
  acquire(): Promise<{ viewerId: string; epoch: number }>
  onRespond(accept: boolean, prompt: string | undefined): void; onChanged(): void
  onDenied(error: unknown): void
}) {
  const dialog = read.dialog?.tabId === tab.tabId ? read.dialog : null
  return <>
    {dialog ? <PageDialog key={`${dialog.type}:${dialog.message}:${dialog.defaultPrompt ?? ''}`} dialog={dialog}
      disabled={disabled || readOnly} onRespond={onRespond} /> : null}
    <BrowserTransfers port={files} session={read.session} tab={tab} downloads={read.files} onChanged={onChanged} onDenied={onDenied}
      acquire={acquire} uploadSelector={!readOnly && !disabled && read.uploadChooser?.tabId === tab.tabId
        ? read.uploadChooser.selector : undefined} />
  </>
}

function PageDialog({ dialog, disabled, onRespond }: {
  dialog: NonNullable<BrowserSessionRead['dialog']>; disabled: boolean
  onRespond(accept: boolean, prompt: string | undefined): void
}) {
  const [prompt, setPrompt] = useState(dialog.defaultPrompt ?? '')
  return <section aria-label="Website dialog" className="agent-browser-dialog">
    <h4>Website {dialog.type}</h4><p>{dialog.message}</p>
    {dialog.type === 'prompt' ? <TextField label="Reply to website" value={prompt} disabled={disabled}
      onChange={event => setPrompt(event.currentTarget.value)} /> : null}
    <Button disabled={disabled} onClick={() => onRespond(true, dialog.type === 'prompt' ? prompt : undefined)}>OK</Button>
    {dialog.type !== 'alert' ? <Button variant="ghost" disabled={disabled} onClick={() => onRespond(false, undefined)}>Cancel</Button> : null}
  </section>
}
