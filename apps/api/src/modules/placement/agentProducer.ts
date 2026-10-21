import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, WorkspaceSchema,
  type AgentConfigurationVersion, type HarnessExecution, type CompatibilityHarness } from '@foreman-code/contracts'
import { HostHarnessOverrideSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { type AcceptedNodePlacement, type DispatchIntent, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { type RunStartV3Input, sameWorkflowValue, workflowUsesAgentPlacements } from '@foreman-code/contracts/wave25'
import { readImmutableWorkflowVersion, IMMUTABLE_WORKFLOW_VERSION_COLUMNS, type ImmutableWorkflowVersionRow } from '../workflows/immutableRead.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { RegistryHarnessSelection } from '../harnesses/installationRegistry.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { RepeatNodeRef } from '../runs/repeatResolution.js'
import { beforeGraphCommit, type GraphSqlClient, type GraphTransactionSql,
  withExclusiveGraphConnection } from '../run-graph/connection.js'
import { requiredLocationAccess } from '../workspaces/location.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { readPlacementHarnessFacts } from './harnessFacts.js'
import { freezePlacement, deriveDispatch, directoryIdentityHash, placementDigest } from './binding.js'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { legacyProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'
import { readAcceptedPlacement, insertDispatchIntent } from './persistence.js'
import type { RunPlacementAdmissionPort, PreparedRunPlacementAdmission } from './startPort.js'
import { readLocalMainRoot, readPlacementRootBinding, resolveBoundRootPlacement, resolveLocalMainPlacement,
  resolvePlacementRootPolicy, resolveWorkflowRootBinding } from './localMainPlacement.js'
import { prepareRunRoots, type SelectedRunRoot } from './runRoots.js'
import { bindGeneratedWorktreeRun, generatedWorktreePrefix } from '../sources/worktreeRequest.js'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { WorktreeComputerSelection } from '@foreman-code/contracts/worktree-settings'
import { assertWorktreeComputers } from '../workflows/worktreeComputers.js'
import { startPlacementFence } from './startFence.js'

function refreshSourcePlacement(
  saved: SavedNodePlacement, roots: ReadonlyMap<string, SourceRootRecord>,
): SavedNodePlacement {
  const root = [...roots.values()].find(root => root.selection.rootPolicyId === saved.rootPolicyId
    && sameWorkflowValue(root.selection.hostRef, saved.hostRef))
  if (!root) return saved
  return {
    ...saved,
    ...root.selection,
    source: root.source,
    rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision },
  }
}

/** Resolve saved locations through the shared source, root and harness services,
 * then freeze the resolved facts on the Run. */
export class AgentPlacementProducer implements RunPlacementAdmissionPort {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly sources: SourceAdmissionPort, private readonly roots: WorkspaceRootPolicyPort,
    private readonly registry: Pick<ProductionHarnessRegistry, 'installations' | 'pinOverride'>,
    private readonly qualificationSuites: Readonly<Record<CompatibilityHarness, string>>,
    private readonly workerExecution = new WorkerExecutionPolicy(),
    private readonly assertProfileReady?: (profile: HostHarnessOverride) => void | Promise<void>,
    private readonly refreshProfileInventory?: (
      hosts: readonly CanonicalMachineReference[], signal?: AbortSignal,
    ) => Promise<void>, private readonly accounts?: ProviderAccountResolver,
    private readonly assertBundleReady?: (host: CanonicalMachineReference) => Promise<void>) {}
  async prepare(input: RunStartV3Input, principal: ManagementPrincipal,
    signal?: AbortSignal, options: {
      source: 'http' | 'mcp'; sourcePreparationStarted?: () => void
    } = { source: 'mcp' }): Promise<PreparedRunPlacementAdmission | undefined> {
    signal?.throwIfAborted()
    let initial = await this.readSelectedRoots(input, principal)
    const savedVersion = initial.version
    signal?.throwIfAborted()
    if (!sameWorkflowValue(savedVersion.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) this.conflict()
    const hosts = savedVersion.definition.nodes.filter(node => node.kind !== 'job')
      .map(node => node.placement?.hostRef ?? initial.root?.selection.hostRef
        ?? { kind: 'main' as const, mainId: this.mainId })
    // The bundle check reads the Worker over its connection, so it uses the preparation budget, not the quick Start deadline.
    if (hosts.length && this.assertBundleReady) options.sourcePreparationStarted?.()
    for (const host of hosts) await this.assertBundleReady?.(host)
    if (hosts.length && this.refreshProfileInventory) {
      // Host discovery makes Worker round-trips, so it uses the preparation budget, not the quick Start deadline.
      options.sourcePreparationStarted?.()
      await this.refreshProfileInventory(hosts, signal)
    }
    signal?.throwIfAborted()
    if (!workflowUsesAgentPlacements(savedVersion.definition) && !initial.repository) return undefined
    if (!initial.root && !initial.repository
      && savedVersion.definition.nodes.some(node => node.kind !== 'job' && !node.placement)) {
      initial = await this.readSelectedRoots(input, principal, { includeImplicitMain: true })
    }
    if (initial.selected.size) options.sourcePreparationStarted?.()
    const refreshed = initial.selected.size ? await prepareRunRoots(this.sources, principal, {
      workspaceId: input.workspaceId, commandId: input.commandId, source: options.source,
    }, [...initial.selected.values()], { captureSource: !!initial.repository }) : []
    signal?.throwIfAborted()
    const roots = new Map([...initial.selected.keys()].map((key, index) => [key, refreshed[index]!]))
    return withExclusiveGraphConnection(this.pool, connection => connection.transaction(async sql => {
      signal?.throwIfAborted()
      if (signal) beforeGraphCommit(sql, async () => signal.throwIfAborted())
      const version = await this.readVersion(sql, input)
      signal?.throwIfAborted()
      if (!sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) this.conflict()
      const nodes = version.definition.nodes.filter(node => node.kind !== 'job')
      if (!workflowUsesAgentPlacements(version.definition) && !initial.repository) return undefined
      const assertRepository = async (sql: GraphSqlClient) => {
        const row = (await sql.query<{ record: unknown }>(
          'select record from workspaces where id=$1 for share', [input.workspaceId])).rows[0]
        const repository = row && WorkspaceSchema.parse(row.record).repository
        if (!sameWorkflowValue(repository, initial.repository)) this.conflict()
      }
      await assertRepository(sql)
      const resolveMain = async (sql: GraphTransactionSql, principal: ManagementPrincipal,
        configuration: AgentConfigurationVersion, nodeId: string) => {
        const context = { sql, principal, configuration, nodeId, mainId: this.mainId, workspaceId: input.workspaceId,
          roots: this.roots, installations: this.registry.installations, qualificationSuites: this.qualificationSuites,
          ...(this.assertProfileReady ? { assertProfileReady: this.assertProfileReady } : {}) }
        if (initial.inheritedRoot) {
          const root = roots.get(initial.inheritedRoot.binding.rootId) ?? initial.inheritedRoot
          return resolveBoundRootPlacement({ ...context, root })
        }
        return refreshSourcePlacement(await resolveLocalMainPlacement(context), roots)
      }
      const resolveInherited = async (sql: GraphTransactionSql, principal: ManagementPrincipal,
        configuration: AgentConfigurationVersion, nodeId: string) => {
        if (!version.definition.defaultWorktree) return resolveMain(sql, principal, configuration, nodeId)
        const root = await resolveWorkflowRootBinding({ sql, principal, workspaceId: input.workspaceId,
          reference: version.definition.defaultWorktree.rootBinding, sources: this.sources })
        return resolveBoundRootPlacement({ sql, principal, configuration, nodeId, root, mainId: this.mainId,
          workspaceId: input.workspaceId, roots: this.roots, installations: this.registry.installations,
          qualificationSuites: this.qualificationSuites,
          ...(this.assertProfileReady ? { assertProfileReady: this.assertProfileReady } : {}) })
      }
      const prepared: { pins: Omit<AcceptedNodePlacement, 'runId' | 'bindingHash'>; selection: RegistryHarnessSelection;
        saved: SavedNodePlacement; configuration: AgentConfigurationVersion; implicit: boolean;
        generatedBranch: boolean }[] = []
      const configurationRows = await sql.query<{ id: string; agent_id: string; record: unknown }>(
        'select id,agent_id,record from agent_configuration_versions where id=any($1::text[]) and workspace_id=$2',
        [Object.values(version.agentConfigurationVersionIds), input.workspaceId])
      for (const node of nodes) {
        signal?.throwIfAborted()
        if (node.placement && node.placement.hostRef.mainId !== this.mainId) this.conflict()
        const configuration = configurationRows.rows.find(row =>
          row.id === version.agentConfigurationVersionIds[node.agentId] && row.agent_id === node.agentId)
        const config = AgentConfigurationVersionSchema.parse(configuration?.record)
        const saved = node.placement ? refreshSourcePlacement(node.placement, roots) : await resolveInherited(sql, principal, config, node.id)
        const instance = await this.readInstance(sql, saved.instanceId)
        await this.assertProfileReady?.(instance)
        if (saved) this.workerExecution.requireEnabled(saved.hostRef)
        if (saved && (saved.relativeCwd.length > 1024 || saved.relativeCwd.includes('\0') || posix.isAbsolute(saved.relativeCwd)
          || saved.relativeCwd.split('/').some(component => component === '..' || component === '.' || component === '' && saved.relativeCwd !== '')
          || saved.cwdPolicy === 'project-root' && saved.relativeCwd !== '' || saved.cwdPolicy === 'project-subdirectory' && saved.relativeCwd === '')) this.conflict()
        if (!saved?.source || !saved.rootBinding || saved.hostRef.mainId !== this.mainId) this.conflict()
        const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId: input.workspaceId, ...saved!.rootBinding!, source: saved!.source! })
        const approved = await this.sources.resolveApprovedSource(sql, principal, input.workspaceId, root.source)
        const branchPrefix = node.worktree?.branchPrefix ?? version.definition.defaultWorktree?.branchPrefix
        const repository = approved.manifest.git?.repository
        if (branchPrefix && (!repository || root.binding.accessMode !== 'exclusive-write')) {
          throw new DomainError('WORKTREE_BRANCH_UNAVAILABLE',
            'An Agent branch prefix requires a writable Git repository source.', 409)
        }
        const worktree = repository && root.binding.accessMode === 'exclusive-write'
          ? { repository, branch: branchPrefix ?? generatedWorktreePrefix(version.definition.name,
            node.name ?? node.label ?? config.agentId) } : undefined
        signal?.throwIfAborted()
        if (requiredLocationAccess([config]) === 'read-write' && root.binding.accessMode !== 'exclusive-write') this.conflict()
        const policy = await this.roots.resolve(sql, principal, { workspaceId: input.workspaceId, hostRef: saved!.hostRef,
          rootPolicyId: saved!.rootPolicyId, rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision })
        signal?.throwIfAborted()
        if (!sameWorkflowValue(root.selection, { hostRef: saved!.hostRef, rootPolicyId: saved!.rootPolicyId,
          rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision }) || !sameWorkflowValue(policy.registration, root.registration)) this.conflict()
        if (!instance.enabled || !sameWorkflowValue(instance.target.hostRef, saved!.hostRef)) this.conflict()
        await this.assertProfileReady?.(instance)
        const selection = this.registry.pinOverride(instance)
        const account = this.accounts && config.harness.harness !== 'opencode' && config.harness.accountId
          ? await this.accounts.resolve(config.harness.harness, config.harness.accountId, { allowDefault: false }) : null
        const accountBinding = account?.binding ?? legacyProviderAccountBinding(config.harness, config.harnessProfileSelection)
        prepared.push({ selection, saved, configuration: config, implicit: !node.placement,
          generatedBranch: !!worktree && !branchPrefix,
          pins: { schemaVersion: 1, mainId: this.mainId, mainInstallationId: this.mainId,
          ...(!node.placement ? { labelAtAcceptance: version.definition.defaultWorktree ? 'Workflow default' : 'Main' } : {}),
          nodeId: node.id, hostRef: saved!.hostRef, registration: root.registration,
          destination: { canonicalProjectRoot: policy.canonicalProjectRoot, canonicalCwd: posix.join(policy.canonicalProjectRoot, saved!.relativeCwd),
            managedRuntimeRoot: policy.managedRuntimeRoot,
            directoryIdentityHash: directoryIdentityHash(saved!.hostRef, root.binding.filesystem.device, root.binding.filesystem.inode),
            rootPolicyId: saved!.rootPolicyId, rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision,
            attestationId: root.attestationId, attestationHash: root.attestationDigest },
          source: { kind: 'pending', ...root.source, revisionId: root.source.snapshotId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, materializationId: null, materializationDigest: null },
          payload: { kind: 'agent', agentId: config.agentId, agentConfigurationVersionId: config.id,
            ...(accountBinding ? { accountBinding } : {}),
            ...(worktree ? { worktree } : {}),
            ...(node.artifactOutputs ? { artifactOutputs: structuredClone(node.artifactOutputs) } : {}),
            driverId: selection.selection.driverId, driverRevision: selection.installation.driverRevision,
            instanceId: selection.selection.instanceId, instanceRevision: selection.selection.instanceRevision,
            harnessInstallationId: selection.selection.harnessInstallationId, installationFingerprint: selection.selection.installationFingerprint,
            runtimeContractVersion: 1, protocolRevision: selection.installation.protocolRevision, credentialScopeRefs: [] } } })
      }
      for (const item of prepared) {
        const facts = await readPlacementHarnessFacts(sql, item.pins, this.registry.installations, this.qualificationSuites)
        signal?.throwIfAborted()
        if (item.pins.payload.kind !== 'agent') this.conflict()
        item.pins.payload.profileProofDigest = placementDigest(facts.profileProof)
        if (facts.qualification) item.pins.payload.qualificationDigest = placementDigest(facts.qualification)
      }
      const bind = (item: typeof prepared[number], runId: string) => {
        const pins = structuredClone(item.pins)
        if (item.generatedBranch && pins.payload.kind === 'agent' && pins.payload.worktree) {
          pins.payload.worktree.branch = bindGeneratedWorktreeRun(pins.payload.worktree.branch, runId)
        }
        return freezePlacement({ ...pins, runId })
      }
      return { bind: runId => prepared.map(item => bind(item, runId)),
        fence: transaction => startPlacementFence(pin => {
          const saved = prepared.find(item => item.pins.nodeId === pin.nodeId)
          if (!saved || !sameWorkflowValue(bind(saved, pin.runId), pin)) this.conflict()
          this.registry.installations.assertCurrent(saved!.selection)
          return saved
        }, async pin => {
          const saved = prepared.find(item => item.pins.nodeId === pin.nodeId)!
          if (this.accounts && pin.payload.kind === 'agent' && pin.payload.accountBinding?.kind === 'slot') {
            const binding = pin.payload.accountBinding
            await this.accounts.resolve(binding.provider, binding.accountId, { sql: transaction,
              allowDefault: false, acceptedBinding: binding })
          }
          const live = await readLiveManagementPrincipal(transaction, principal.id)
          await assertRepository(transaction)
          if (saved.implicit) {
            const current = version.definition.defaultWorktree
              ? await resolveInherited(transaction, live, saved.configuration, pin.nodeId)
              : await resolveLocalMainPlacement({ sql: transaction, principal: live,
                configuration: saved.configuration, nodeId: pin.nodeId, mainId: this.mainId, workspaceId: input.workspaceId,
                roots: this.roots, installations: this.registry.installations,
                qualificationSuites: this.qualificationSuites })
            if (!sameWorkflowValue(saved.saved, current)) this.conflict()
          }
          await this.assertPinsCurrent(transaction, pin, live, input.workspaceId)
        }) }
    }))
  }
  private async readSelectedRoots(input: RunStartV3Input, principal: ManagementPrincipal,
    options: { includeImplicitMain?: boolean } = {}) {
    return withExclusiveGraphConnection(this.pool, async connection => {
      const version = await this.readVersion(connection, input)
      const needsDefault = version.definition.nodes.some(node => node.kind !== 'job' && !node.placement)
      const root = needsDefault && version.definition.defaultWorktree
        ? await resolveWorkflowRootBinding({ sql: connection, principal, workspaceId: input.workspaceId,
          reference: version.definition.defaultWorktree.rootBinding, sources: this.sources }) : undefined
      const workspace = (await connection.query<{ record: unknown }>(
        'select record from workspaces where id=$1', [input.workspaceId])).rows[0]
      const repository = workspace && WorkspaceSchema.parse(workspace.record).repository
      const selected = new Map<string, SelectedRunRoot>()
      const computers: WorktreeComputerSelection[] = []
      let inheritedRoot = root
      for (const node of version.definition.nodes) {
        if (node.kind === 'job' || !node.placement && !root && !repository && !options.includeImplicitMain) continue
        if (node.placement && node.placement.hostRef.mainId !== this.mainId) this.conflict()
        let selectedRoot = root
        if (node.placement) {
          selectedRoot = await readPlacementRootBinding({ sql: connection, principal,
            workspaceId: input.workspaceId, placement: node.placement, sources: this.sources,
          })
          if (selectedRoot.selection.rootPolicyId !== node.placement.rootPolicyId
            || !sameWorkflowValue(selectedRoot.selection.hostRef, node.placement.hostRef)) this.conflict()
        } else if (!selectedRoot) {
          selectedRoot = await readLocalMainRoot({ sql: connection, principal, mainId: this.mainId,
            workspaceId: input.workspaceId, roots: this.roots })
        }
        if (!node.placement) inheritedRoot = selectedRoot
        const policy = await resolvePlacementRootPolicy({ sql: connection, principal,
          workspaceId: input.workspaceId, selection: selectedRoot.selection, roots: this.roots })
        selected.set(selectedRoot.binding.rootId, { root: selectedRoot, policy })
        const branchPrefix = node.worktree?.branchPrefix ?? version.definition.defaultWorktree?.branchPrefix
        if (branchPrefix) computers.push({ branchPrefix, agentName: node.name ?? node.label ?? node.agentId,
          hostRef: selectedRoot.selection.hostRef })
      }
      await assertWorktreeComputers(connection, computers)
      return { version, root, repository, selected, inheritedRoot }
    })
  }
  private async readVersion(sql: GraphSqlClient, input: RunStartV3Input) {
    const row = (await sql.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
      from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
    [input.workflowVersionId, input.workspaceId, input.workflowId])).rows[0]
    if (!row) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'Exact saved workflow version is required.', 404)
    return readImmutableWorkflowVersion(row)
  }
  harnessFacts(sql: GraphTransactionSql, pin: AcceptedNodePlacement, options?: { purpose: 'resident' }) {
    return readPlacementHarnessFacts(sql, pin, this.registry.installations, this.qualificationSuites, options)
  }
  async assertPinsCurrent(sql: GraphSqlClient, pin: AcceptedNodePlacement,
    principal: ManagementPrincipal, workspaceId: string, options?: { purpose: 'resident' }): Promise<void> {
    await this.assertSourceCurrent(sql, pin, principal, workspaceId)
    if (pin.payload.kind !== 'agent') this.conflict()
    if (options?.purpose !== 'resident') {
      const instance = await this.readInstance(sql, pin.payload.instanceId)
      if (!instance.enabled || instance.instanceRevision !== pin.payload.instanceRevision) this.conflict()
    }
    await readPlacementHarnessFacts(sql, pin, this.registry.installations, this.qualificationSuites, options)
  }
  private async assertSourceCurrent(sql: GraphSqlClient, pin: AcceptedNodePlacement,
    principal: ManagementPrincipal, workspaceId: string): Promise<void> {
    if (!('kind' in pin.source) || pin.source.kind !== 'pending') this.conflict()
    const source = pin.source as Extract<AcceptedNodePlacement['source'], { kind: 'pending' }>
    const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId, rootId: source.rootId,
      bindingRevision: source.bindingRevision, source: { approvedSourceId: source.approvedSourceId, snapshotId: source.snapshotId, manifestDigest: source.manifestDigest } })
    if (!sameWorkflowValue(root.registration, pin.registration) || root.attestationDigest !== pin.destination.attestationHash) this.conflict()
    await this.roots.resolve(sql, principal, { workspaceId, hostRef: pin.hostRef, rootPolicyId: pin.destination.rootPolicyId,
      rootPolicyRevision: pin.destination.rootPolicyRevision, locationRevision: pin.destination.locationRevision })
    if (pin.payload.kind !== 'agent') this.conflict()
    const registration = await assertDeviceHostInstallation(sql, pin.hostRef, pin.registration?.workerInstallationId ?? pin.mainInstallationId)
    if (!sameWorkflowValue(registration === null ? null : { workerInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }, pin.registration)) this.conflict()
  }
  private async readInstance(sql: GraphSqlClient, instanceId: string) {
    // Match settings append's lock so a new revision cannot cross the commit fence.
    await sql.query('select pg_advisory_xact_lock_shared(hashtext($1))', [`harness-instance:${instanceId}`])
    const row = (await sql.query<{ record: unknown }>(`select record from harness_instance_settings
      where instance_id=$1 order by revision desc limit 1 for share`, [instanceId])).rows[0]
    const parsed = HostHarnessOverrideSchema.safeParse(row?.record)
    if (!parsed.success) this.conflict()
    return parsed.data
  }
  /** Concrete same-owner admission callback after canonical execution/slot INSERT.
   * No worktree/native resource is allocated for an unselected occurrence. */
  async admitExecution(sql: GraphTransactionSql, owner: RunOwnership, execution: HarnessExecution,
    ref: RepeatNodeRef, inputDigest: string, principalId: string): Promise<DispatchIntent | undefined> {
    const pin = await readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId)
    if (!pin) return undefined
    const principal = await readLiveManagementPrincipal(sql, principalId)
    const run = (await sql.query<{ workspace_id: string }>('select workspace_id from runs where id=$1', [execution.runId])).rows[0]
    if (!run) this.conflict()
    const scheduler = await owner.readOneShotFence(sql)
    const intent = deriveDispatch(pin!, { executionId: execution.id, occurrenceId: ref.occurrence?.occurrenceId ?? null,
      occurrenceIndex: ref.occurrence?.occurrenceIndex ?? 0, technicalAttempt: execution.attempt,
      attemptId: randomUUID(), operationId: randomUUID(), inputDigest, owner: { grantId: randomUUID(), epoch: '1' } })
    await sql.query(`insert into execution_dispatch_owner_grants(execution_id,operation_id,grant_id,epoch,scheduler_owner_id,scheduler_owner_fence)
      values($1,$2,$3,$4,$5,$6)`, [execution.id, intent.operationId, intent.owner.grantId, intent.owner.epoch, scheduler.ownerId, scheduler.fence])
    // Dispatch reserves work. Preparation checks the live profile before any native entry,
    // so a refused profile has a persisted execution on which to report its failure.
    const fence = { assertCurrent: (placement: AcceptedNodePlacement) =>
      this.assertSourceCurrent(sql, placement, principal, run!.workspace_id) }
    const accepted = await insertDispatchIntent(sql, owner, intent, fence)
    beforeGraphCommit(sql, async () => { owner.assertOwned(); await owner.readOneShotFence(sql) })
    return accepted
  }
  private conflict(): never {
    throw new DomainError('PLACEMENT_ADMISSION_CONFLICT',
      'The selected root and enabled harness instance must be available on the selected computer.', 409)
  }
}
