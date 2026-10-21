import { useMutation } from '@tanstack/react-query'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import { Alert, Button } from '../../shared/ui/nocturne'
import { downloadJobArtifact } from './client'
import { jobError } from './model'

export function ArtifactDownload({ workspaceId, artifact }: { workspaceId: string; artifact: JobArtifact }) {
  const download = useMutation({ mutationFn: () => downloadJobArtifact(workspaceId, artifact), retry: false,
    onSuccess: blob => {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = artifact.path.split('/').at(-1) ?? 'artifact'; anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } })
  return <><Button loading={download.isPending} disabled={artifact.state !== 'available'} onClick={() => download.mutate()}>Download pinned revision</Button>{download.error && <Alert title="Job status" tone="danger">{jobError(download.error)}</Alert>}</>
}
