import { InfoHint } from '../../shared/ui/InfoHint'
import { useState } from 'react'
import { Button, Dialog, Select } from '../../shared/ui/nocturne'
import { useHarnessDirectories, useHarnessSessionEpoch } from '../../shared/api/harnessSettings'

type Props = { value: string[]; onChange(value: string[]): void; error?: string }
function DirectoryPicker({ value, onChange, error }: Props) {
  const [open, setOpen] = useState(false)
  const [location, setLocation] = useState<{ rootId?: string; path?: string; cursor?: string }>({})
  const query = useHarnessDirectories(location, open)
  const data = query.data
  return <section className="harness-directory-picker" aria-label="Additional writable directories">
    <div className="harness-section-heading"><h4>Additional folders{!value.length ? <InfoHint label="Additional folders">Only the current workspace is added.</InfoHint> : null}</h4><Button size="sm" onClick={() => { setLocation({}); setOpen(true) }}>Browse folders</Button></div>
    {value.length ? <ul className="harness-folder-list">{value.map((path, index) => <li key={`${path}-${index}`}><span title={path}>{path}</span>
      <Button size="sm" variant="ghost" aria-label={`Remove writable folder ${path}`} onClick={() => onChange(value.filter((_, position) => position !== index))}>Remove</Button></li>)}</ul>
      : null}
    {error ? <p className="n-field-error" role="alert">{error}</p> : null}
    <Dialog open={open} onOpenChange={setOpen} title="Choose a runner folder" size="md"
      headerLeading={<InfoHint label="Choose a runner folder">Folders on the server, not files on your device.</InfoHint>}
      footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!data?.path || query.isFetching || query.isError}
        onClick={() => { if (data?.path) onChange([...new Set([...value, data.path])]); setOpen(false) }}>Add this folder</Button></>}>
      <div className="harness-folder-browser">
        {data?.roots.length ? <Select label="Allowed location" value={data.rootId ?? ''} options={data.roots.map((root) => ({ value: root.id, label: root.label }))}
          onChange={(event) => setLocation({ rootId: event.target.value })} /> : null}
        <div className="harness-folder-path"><Button size="sm" disabled={!data?.parent || query.isFetching} onClick={() => {
          if (data?.parent && data.rootId) setLocation({ rootId: data.rootId, path: data.parent })
        }}>Up</Button><span title={data?.path ?? ''}>{data?.path ?? 'Allowed folders'}</span></div>
        {query.isFetching ? <p role="status">Loading folders…</p> : null}
        {query.isError ? <p role="alert">{query.error.message} <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}
        {!query.isFetching && data?.directories.length === 0 ? <p className="harness-muted">No subfolders here.</p> : null}
        <div className="harness-folder-entries">{data?.directories.map((entry) => <Button key={entry.path} variant="ghost" className="harness-folder-entry"
          disabled={query.isFetching} onClick={() => { if (data.rootId) setLocation({ rootId: data.rootId, path: entry.path }) }}><span aria-hidden="true">▱</span> {entry.name}<span aria-hidden="true">›</span></Button>)}</div>
        {data?.nextCursor ? <Button size="sm" onClick={() => setLocation({ ...location, rootId: data.rootId ?? undefined, path: data.path ?? undefined, cursor: data.nextCursor! })}>Next folders</Button> : null}
      </div>
    </Dialog>
  </section>
}

export function HarnessDirectoryPicker(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <DirectoryPicker key={epoch} {...props} />
}
