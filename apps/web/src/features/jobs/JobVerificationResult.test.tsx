import { Blob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { server } from '../../mocks/server'
import { jobKeys } from './query'
import { JobResult } from './JobResult'
import { verificationExecution, verificationReport } from './fixtures'

const root = '*/api/management/workspaces/:workspaceId/jobs/executions/:id'
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('Blob', Blob)
})
afterEach(() => vi.unstubAllGlobals())

async function responses(report: unknown = verificationReport, execution: JobExecutionRecord = verificationExecution,
  missingOutput = false) {
  const text = JSON.stringify(report)
  const bytes = new TextEncoder().encode(text)
  const hash = await webcrypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const artifacts: JobArtifact[] = execution.acceptedSpec.outputs.map((output, index) => ({
    executionId: execution.id, fileId: `report-${index}`, revisionId: `revision-${index}`,
    publicationId: `publication-${index}`, path: output.path, mediaType: output.mediaType,
    sha256, byteSize: bytes.byteLength, state: 'available', expiresAt: '2026-10-02T00:00:00Z',
  }))
  if (missingOutput) artifacts.pop()
  server.use(
    http.get(root, () => HttpResponse.json({ execution })),
    http.get(`${root}/logs`, () => HttpResponse.json({ chunks: [], nextCursor: 0, truncated: false, gap: null })),
    http.get(`${root}/artifacts`, () => HttpResponse.json({ artifacts })),
    http.get(`${root}/artifacts/:fileId/revisions/:revisionId/content`, () => new HttpResponse(text)),
  )
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })
  const view = render(<QueryClientProvider client={client}>
    <JobResult workspaceId={verificationExecution.workspaceId} executionId={verificationExecution.id} />
  </QueryClientProvider>)
  return { ...view, client }
}

it('reads immutable summary bytes and shows a complete verification pass with suite and case counts', async () => {
  await responses()
  mount()
  expect(await screen.findByText('Verification: passed')).toBeInTheDocument()
  expect(screen.getByText('8 passed · 0 failed · 0 skipped · 8 total')).toBeInTheDocument()
  expect(screen.getByText('2 of 2 · complete')).toBeInTheDocument()
  expect(screen.getByText('none')).toBeInTheDocument()
})

it.each([
  { attemptId: 'another-attempt' },
  { commit: 'c'.repeat(40) },
  { completeness: 'partial', completedPortions: 1 },
  { firstPassFailed: 1 },
])('rejects a summary that cannot establish this verification pass: %j', async change => {
  await responses({ ...verificationReport, ...change })
  mount()
  expect(await screen.findByText('The verification summary does not match this accepted source and attempt.'))
    .toBeInTheDocument()
  expect(screen.queryByText('Verification: passed')).toBeNull()
})

it('does not display a pass while a required companion report is missing', async () => {
  await responses(verificationReport, verificationExecution, true)
  mount()
  expect(await screen.findByText('Verification: pass not confirmed')).toBeInTheDocument()
  expect(screen.queryByText('Verification: passed')).toBeNull()
})

it('uses the required summary when an optional summary is declared first', async () => {
  const optional = { path: '.logs/verification/optional.json', kind: 'suite-summary' as const,
    required: false, mediaType: 'application/json' as const, maxBytes: 4096 }
  const outputs = [optional, ...verificationExecution.acceptedSpec.outputs.map(output => ({
    ...output, maxBytes: output.maxBytes - 1024,
  }))]
  await responses(verificationReport, { ...verificationExecution,
    acceptedSpec: { ...verificationExecution.acceptedSpec, outputs } })
  const optionalRead = vi.fn()
  server.use(http.get(`${root}/artifacts/report-0/revisions/revision-0/content`, () => {
    optionalRead()
    return HttpResponse.error()
  }))
  mount()
  expect(await screen.findByText('Verification: passed')).toBeInTheDocument()
  expect(optionalRead).not.toHaveBeenCalled()
})

it('presents a retained partial timeout report with first-pass failures', async () => {
  await responses({ ...verificationReport, outcome: 'timed_out', completeness: 'partial', completedPortions: 1,
    totals: { total: 8, passed: 6, failed: 1, skipped: 1 }, firstPassFailed: 1, disallowedSkipped: 1 },
  { ...verificationExecution, process: { ...verificationExecution.process, outcome: 'timed_out', exitCode: null } })
  mount()
  expect(await screen.findByText('Verification: timed out')).toBeInTheDocument()
  expect(screen.getByText('6 passed · 1 failed · 1 skipped · 8 total')).toBeInTheDocument()
  expect(screen.getByText('1 of 2 · partial')).toBeInTheDocument()
})

it('hides the summary when authenticated artifact content is denied', async () => {
  await responses()
  server.use(http.get(`${root}/artifacts/:fileId/revisions/:revisionId/content`, () =>
    HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied' } }, { status: 403 })))
  mount()
  expect(await screen.findByText('Verification report unavailable')).toBeInTheDocument()
  expect(screen.queryByText('8 passed · 0 failed · 0 skipped · 8 total')).toBeNull()
})

it.each(['expired', 'tombstoned'] as const)('withdraws a cached report when its artifact becomes %s', async state => {
  await responses()
  const { client } = mount()
  await screen.findByText('Verification: passed', {}, { timeout: 3000 })
  const key = jobKeys.artifacts(verificationExecution.workspaceId, verificationExecution.id)
  const artifacts = client.getQueryData<JobArtifact[]>(key)!
  await act(async () => { client.setQueryData(key, artifacts.map(artifact => ({ ...artifact, state }))) })
  await screen.findByText(state === 'expired'
    ? 'The verification summary has expired.' : 'The verification summary is unavailable.', {}, { timeout: 3000 })
  expect(screen.queryByText('8 passed · 0 failed · 0 skipped · 8 total')).toBeNull()
}, 10000)

it.each(['pending', 'collecting', 'failed'] as const)('explains a missing summary when publication is %s', async publication => {
  await responses(verificationReport, { ...verificationExecution, publication,
    resultIssue: publication === 'failed' ? 'missing_output' : null })
  server.use(http.get(`${root}/artifacts`, () => HttpResponse.json({ artifacts: [] })))
  mount()
  const message = publication === 'failed'
    ? 'Verification summary unavailable. Publication failed: missing output.'
    : 'Waiting for the verification summary. Process exit alone does not confirm a suite pass.'
  expect(await screen.findByText(message)).toBeInTheDocument()
  if (publication === 'failed') {
    expect(screen.queryByText(/Waiting for the verification summary/)).toBeNull()
    expect(screen.queryAllByText('Awaiting publication')).toHaveLength(0)
  }
  expect(screen.queryByText('Verification: passed')).toBeNull()
})
