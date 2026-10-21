import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { NodePlacementField } from './NodePlacementField'
import { NodePlacementFacts } from './NodePlacementFacts'
import { acceptedPlacementFixture as placement, savedPlacementFixture as saved, workerObservationFixture as observation } from './fixtures'
import { NativeExecutionPlacementSchema } from '@foreman-code/contracts/node-placement'
import { worktreeFixture } from '../workflow-board/worktree.fixtures'

it('shows Main as the default without inventing or applying a saved placement', async () => {
  const change = vi.fn()
  const view = render(<NodePlacementField options={[{ label: 'Laptop', placement: saved }]} onChange={change} />)
  expect(screen.getByRole('option', { name: 'Main (default)' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Computer' })).toHaveValue('inherited')
  expect(screen.getByText(/Inherited from workflow: Main through existing workspace placement/)).toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
  view.rerender(<NodePlacementField value={saved} stage="draft"
    options={[{ label: 'Laptop', placement: saved }]} onChange={vi.fn()} />)
  expect(screen.getByRole('status')).toHaveTextContent('Applied to draft')
  expect(screen.queryByText(/Start records every Agent’s authorized source, root and harness in the Run/)).not.toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About Computer' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(/Start records every Agent’s authorized source, root and harness in the Run/)
})

it('retains removed placement and never silently selects the main computer', async () => {
  const change = vi.fn()
  render(<NodePlacementField value={saved} options={[{ label: 'PC', placement: { ...saved, hostRef: { kind: 'main', mainId: saved.hostRef.mainId } } }]} onChange={change} />)
  expect(screen.getByRole('combobox', { name: 'Computer' })).toHaveValue('retained')
  expect(screen.getByText(/no longer available/)).toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
  await userEvent.selectOptions(screen.getByRole('combobox'), '0')
  expect(change.mock.calls[0]?.[0].hostRef.kind).toBe('main')
})
it('lets an explicit or unavailable placement return to inherited Main', async () => {
  const change = vi.fn()
  render(<NodePlacementField value={saved} options={[]} onChange={change} />)
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), 'inherited')
  expect(change).toHaveBeenCalledExactlyOnceWith(undefined)
})
it('shows restricted or incompatible choices without allowing selection', async () => {
  render(<NodePlacementField value={saved} options={[{ label: 'Laptop', placement: saved, unavailableReason: 'Root access restricted' }]} onChange={vi.fn()} />)
  expect(screen.getByRole('option', { name: 'Laptop — Root access restricted' })).toBeDisabled()
  expect(screen.getByText('Root access restricted')).toBeInTheDocument()
  expect(screen.queryByText(/Save graph persists/)).not.toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About Computer' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(/Save graph persists/)
})
it('renders accepted pins without claiming execution before acknowledgment', () => {
  render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [] }} />)
  expect(screen.getByText('Laptop at acceptance')).toBeInTheDocument()
  expect(screen.getAllByText('/synthetic/accepted', { selector: 'dd' })).toHaveLength(2)
  expect(screen.getByText(/Awaiting worker acknowledgment/)).toBeInTheDocument()
  expect(screen.queryByText(/Execution observed on/)).not.toBeInTheDocument()
})

it('shows the accepted prefix separately from the allocated branch and prepared execution directory', () => {
  const project = worktreeFixture()
  const digest = placement.bindingHash
  const filesystem = project.root.binding.filesystem
  const materializationId = '12345678-1234-4234-8234-123456789012'
  const native = NativeExecutionPlacementSchema.parse({ version: 1, acceptedBindingHash: digest, runId: 'run-a',
    nodeId: 'node-a', executionId: 'execution-a', attemptId: 'attempt-a', operationId: 'operation-a', bindingHash: digest,
    materialization: { rootPolicyId: placement.destination.rootPolicyId, rootPolicyRevision: placement.destination.rootPolicyRevision,
      operationId: 'operation-a', reservationId: '12345678-1234-4234-8234-123456789013', sourceBindingHash: digest,
      finalDispatchBindingHash: digest, state: 'prepared', receipt: { version: 1, materializationId, binding: project.root.binding,
        placementHash: digest, executionId: 'execution-a', attemptId: 'attempt-a', keyRevision: 1, authorizationRevision: 2,
        verifiedManifestDigest: project.source.manifest.manifestDigest, verifiedEntries: 0, verifiedBytes: 0,
        verifiedAt: project.source.approvedAt, claimScope: 'execution',
        sharedTree: { id: '12345678-1234-4234-8234-123456789014', referenceIdentity: filesystem },
        worktree: { repository: 'octo-owner/website', branch: 'foreman/review-unique', commit: project.source.manifest.git!.commit },
        localTreeIdentity: filesystem } },
    workingTree: { materializationId, materializationDigest: digest, canonicalProjectRoot: '/runtime/worktree/unique',
      canonicalCwd: '/runtime/worktree/unique', directoryIdentityHash: digest, filesystem,
      accessMode: 'exclusive-write', privateGit: null } })
  if (placement.payload.kind !== 'agent') throw new Error('Expected an Agent placement.')
  const accepted = { ...placement, payload: { ...placement.payload,
    worktree: { repository: 'octo-owner/website', branch: 'foreman/review' } } }
  const view = render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted',
    placement: accepted, observations: [], nativePlacements: [native] }} />)
  expect(screen.getByText('foreman/review')).toBeVisible()
  expect(screen.getByText('foreman/review-unique')).toBeVisible()
  expect(screen.getByText('/runtime/worktree/unique')).toBeVisible()
  expect(screen.queryByText(/Execution observed on/)).not.toBeInTheDocument()
  view.rerender(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted',
    placement: accepted, observations: [], nativePlacements: [{ ...native, acceptedBindingHash: 'f'.repeat(64) }] }} />)
  expect(screen.queryByText('/runtime/worktree/unique')).not.toBeInTheDocument()
})
it('worker acceptance does not claim a process ran; latest matching attempt phase does', () => {
  const view = render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [observation] }} />)
  expect(screen.getByText(/Worker acknowledged acceptance/)).toBeInTheDocument()
  view.rerender(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement,
    observations: [{ ...observation, sequence: '2', phase: 'running', native: { processId: 123 } }, observation,
      { ...observation, attemptId: 'attempt-b', operationId: 'operation-b', executionId: 'execution-b', sequence: '3', phase: 'entered' }] }} />)
  expect(screen.getAllByText(/Execution observed on Laptop at acceptance/)).toHaveLength(1)
  expect(screen.getByText(/Worker entered observation/)).toBeInTheDocument()
  expect(screen.getByText('123')).toBeInTheDocument()
  expect(screen.getByText('attempt-b')).toBeInTheDocument()
})
it('ignores a different binding or worker identity', () => {
  render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [
    { ...observation, phase: 'running', bindingHash: 'b'.repeat(64) },
    { ...observation, phase: 'running', connection: { ...observation.connection, authorizationRevision: 3 } },
  ] }} />)
  expect(screen.queryByText(/Execution observed on/)).not.toBeInTheDocument()
})
it('withdraws private facts on selection change, missing legacy data and access loss', () => {
  const view = render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [] }} />)
  view.rerender(<NodePlacementFacts runId="run-b" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [] }} />)
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
  view.rerender(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'legacy_missing', originalMainInstallationId: null }} />)
  expect(screen.getByText(/Current computer settings are not substituted/)).toBeInTheDocument()
  view.rerender(<NodePlacementFacts runId="run-a" nodeId="node-a" />)
  expect(screen.queryByText('/synthetic/accepted')).not.toBeInTheDocument()
})

it('does not describe a configured host as removed while authorized choices are loading', () => {
  render(<NodePlacementField value={saved} options={[]} optionsState="loading" onChange={vi.fn()} />)
  expect(screen.getByText('Reading authorized computer choices…')).toBeInTheDocument()
  expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument()
})

it('retains earlier process-start evidence when a later terminal observation omits native metadata', () => {
  render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [
    { ...observation, sequence: '3', phase: 'terminal' }, { ...observation, sequence: '2', phase: 'running' },
  ] }} />)
  expect(screen.getByText('Execution observed on Laptop at acceptance · terminal')).toBeInTheDocument()
})


it('shows main-local observation availability without awaiting a nonexistent worker or inferring execution', () => {
  const mainPlacement = { ...placement, hostRef: { kind: 'main' as const, mainId: placement.mainId }, registration: null, labelAtAcceptance: 'Main at acceptance' }
  render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement: mainPlacement, observations: [observation] }} />)
  expect(screen.getByText('Main-local execution observations are unavailable in this readback. Accepted placement does not confirm execution.')).toBeInTheDocument()
  expect(screen.queryByText(/Awaiting worker acknowledgment/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Execution observed on/)).not.toBeInTheDocument()
  expect(screen.getByText('Main at acceptance')).toBeInTheDocument()
  expect(screen.getByText(mainPlacement.source.revisionId, { selector: 'code' })).toBeInTheDocument()
})
