import { webcrypto } from 'node:crypto'
import { it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import { server } from '../../mocks/server'
import { downloadJobArtifact } from './client'
import { execution } from './fixtures'
const artifact: JobArtifact = { executionId: execution.id, fileId: 'file-a', revisionId: 'revision-a', publicationId: 'publication-a', sha256: 'a'.repeat(64), byteSize: 3, path: 'output.html', mediaType: 'text/html', state: 'available', expiresAt: '2026-10-01T01:00:00Z' }
const route = '*/api/management/workspaces/:workspaceId/jobs/executions/:id/artifacts/:fileId/revisions/:revisionId/content'
it('rejects corrupt bytes even if the immutable read returns HTTP200', async () => {
  vi.stubGlobal('crypto', webcrypto)
  server.use(http.get(route, () => new HttpResponse('abc')))
  await expect(downloadJobArtifact(execution.workspaceId, artifact)).rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })
  vi.unstubAllGlobals()
})
it('saves verified HTML as an octet-stream attachment without app-origin navigation', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const sha256 = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))), byte => byte.toString(16).padStart(2, '0')).join('')
  let requested: Request | undefined
  server.use(http.get(route, ({ request }) => { requested = request; return new HttpResponse('abc') }))
  const bytes = await downloadJobArtifact(execution.workspaceId, { ...artifact, sha256 })
  expect(bytes.type).toBe('application/octet-stream')
  expect(bytes.size).toBe(3)
  expect(requested!.url).toContain('/file-a/revisions/revision-a/content')
  expect(requested!.credentials).toBe('omit')
  vi.unstubAllGlobals()
})
it('does not read expired artifact bytes or substitute a newer revision', async () => {
  await expect(downloadJobArtifact(execution.workspaceId, { ...artifact, state: 'expired' })).rejects.toMatchObject({ code: 'ARTIFACT_UNAVAILABLE' })
})
