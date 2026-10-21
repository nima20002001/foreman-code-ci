import type pg from 'pg'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { WorkspaceBoundLocationReadbackSchema } from '@foreman-code/contracts/workspace-bound-location'
import { SourceApproveInputSchema, SourceRootBindInputSchema, ApprovedSourceSchema,
  SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceRepositoryAddInput } from '@foreman-code/contracts/workspace-git'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { repositoryProjectPath } from './repositoryPreparation.js'
import type { RepositoryImport } from './repositoryJournal.js'

export function repositorySubcommand(input: WorkspaceRepositoryAddInput, phase: string): string {
  return `repository-${phase}-${commandInputHash({ commandId: input.commandId, phase }).slice(0, 40)}`
}

export function repositoryRootSelection(attempt: RepositoryImport, mainId: string): WorkspaceRootSelection {
  const input = attempt.input
  return { workspaceId: input.workspaceId, hostRef: { kind: 'main', mainId },
    allowedBaseId: input.allowedBaseId, configurationRevision: input.configurationRevision,
    relativePath: `${attempt.preparation.directoryName}/project`, accessMode: 'read-write',
    expectedLocationRevision: input.expectedLocationRevision, expectedRootPolicyRevision: input.expectedRootPolicyRevision }
}

export function repositoryRootBindInput(attempt: RepositoryImport) {
  const input = attempt.input
  const location = attempt.results.location
  const approved = attempt.results.approvedSource
  if (location?.evidence !== 'bound' || !approved) {
    throw new DomainError('REPOSITORY_RECOVERY_CONFLICT', 'The saved source binding has incomplete import results.', 409)
  }
  return SourceRootBindInputSchema.parse({ workspaceId: input.workspaceId,
    commandId: repositorySubcommand(input, 'bound'), expectedBindingRevision: input.expectedBindingRevision,
    source: { approvedSourceId: approved.manifest.approvedSourceId, snapshotId: approved.manifest.snapshotId,
      manifestDigest: approved.manifest.manifestDigest },
    selection: { hostRef: location.binding.hostRef,
      rootPolicyId: location.binding.rootPolicyId, rootPolicyRevision: location.binding.rootPolicyRevision,
      locationRevision: location.binding.locationRevision }, accessMode: 'exclusive-write' })
}

interface CommandReceipt { result: unknown; input_hash: string; target_key: string }
function assertReceipt(receipt: CommandReceipt, payload: unknown, targetKey: string): void {
  if (receipt.input_hash !== commandInputHash(payload) || receipt.target_key !== targetKey) {
    throw new DomainError('COMMAND_ID_CONFLICT', 'An import subcommand was already used with different input.', 409)
  }
}

/** Adopt committed results only after matching the original subcommand's complete input. */
export async function recoverRepositoryCommands(pool: pg.Pool, attempt: RepositoryImport, mainId: string): Promise<void> {
  const input = attempt.input
  const read = async (operation: string, phase: string) => (await pool.query<CommandReceipt>(
    `select result,input_hash,target_key from management_command_receipts
     where principal_id=$1 and operation=$2 and command_id=$3`,
    [attempt.principalId, operation, repositorySubcommand(input, phase)])).rows[0]
  const metadata = await read('workspace.update', 'metadata')
  if (metadata) {
    assertReceipt(metadata, { workspaceId: input.workspaceId, commandId: repositorySubcommand(input, 'metadata'),
      expectedRevision: input.expectedRevision, repository: input.repository }, `workspace:${input.workspaceId}`)
    attempt.results.workspace = ManagedWorkspaceSchema.parse(metadata.result)
  }
  const location = await read('workspace.location.set', 'location')
  if (location) {
    assertReceipt(location, { ...repositoryRootSelection(attempt, mainId),
      commandId: repositorySubcommand(input, 'location') }, `workspace:${input.workspaceId}:location`)
    attempt.results.location = WorkspaceBoundLocationReadbackSchema.parse(location.result)
  }
  const approval = await read('source.approve', 'approved')
  if (approval) {
    const capture = await read('source.project.capture', 'approved')
    const savedLocation = attempt.results.location
    if (!capture || savedLocation?.evidence !== 'bound' || !attempt.preparation.commit) {
      throw new DomainError('REPOSITORY_RECOVERY_CONFLICT', 'The saved source approval lacks its original capture.', 409)
    }
    const repository = `${input.repository.owner}/${input.repository.name}`
    assertReceipt(capture, { workspaceId: input.workspaceId, commandId: repositorySubcommand(input, 'approved'),
      commit: attempt.preparation.commit, prepared: { repository, clone: repositoryProjectPath(attempt.preparation),
        commit: attempt.preparation.commit, locationRevision: savedLocation.locationRevision } }, input.workspaceId)
    const request = SourceApproveInputSchema.parse(capture.result)
    if (request.workspaceId !== input.workspaceId || request.commandId !== repositorySubcommand(input, 'approved')
      || request.commit !== attempt.preparation.commit || request.expectedLocationRevision !== savedLocation.locationRevision) {
      throw new DomainError('REPOSITORY_RECOVERY_CONFLICT', 'The saved source capture changed its import pins.', 409)
    }
    assertReceipt(approval, request, `workspace:${input.workspaceId}:source`)
    attempt.results.approvedSource = ApprovedSourceSchema.parse(approval.result)
  }
  const binding = await read('source.root.bind', 'bound')
  if (binding) {
    assertReceipt(binding, repositoryRootBindInput(attempt), `workspace:${input.workspaceId}:source-root`)
    const record = SourceRootRecordSchema.parse(binding.result)
    attempt.results.rootBinding = { rootId: record.binding.rootId, bindingRevision: record.binding.bindingRevision }
  }
}
