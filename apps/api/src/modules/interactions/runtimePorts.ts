import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'

import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { AgentConfigurationVersion, AgentHarness, DurableInteraction, NativeSessionReference, ReviewJob,
  HarnessExecutionRequest, CoordinatorConsultationBinding } from '@foreman-code/contracts'
import type { WorkflowArtifactOutputsV1 } from '@foreman-code/contracts/workflow-artifact-result'

import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { RunOwnership } from '../runs/ownership.js'

export interface NativeManagerOwnershipContext {
  reviewJob?: ReviewJob
  purpose?: 'reviewer' | 'consultation'
  consultation?: CoordinatorConsultationBinding
  correlationId?: string
  nativeTurnId?: string
  harness: AgentHarness
  executionId: string
  agentId: string
  workingDirectory: string
}

export interface NativeManagerResolutionContext extends NativeManagerOwnershipContext {
  /** Immutable configuration version pinned by the durable execution. */
  configuration: AgentConfigurationVersion
  runId?: string
  attempt?: number
  nativeSessionId?: string
  /** Exact immutable W08 placement loaded by the existing continuation owner. */
  acceptedPlacement?: AcceptedNodePlacement
  artifactOutputs?: WorkflowArtifactOutputsV1
  /** Accepted engine request retained for inspection before the first model input. */
  workflowRequest?: HarnessExecutionRequest
}

export type NativeManagerLifecycle = 'allocated' | 'starting' | 'resident' | 'disposing' | 'released' | 'failed'

export interface ResolvedNativeSessionManager {
  manager: NativeHarnessSessionManager
  /** True only when create/attach must start a new provider process. */
  readonly processState: 'resident' | 'needs_start'
  readonly lifecycle?: NativeManagerLifecycle
  /** Claim startup before credential preflight; allocation alone is not residency. */
  beginStart?(): void
  /** Called only after the provider successfully creates/attaches the exact session. */
  markResident?(): void
  /** Fence reuse while failed-process/credential cleanup is still running. */
  markFailed?(): void
}

/** Manager ownership is per durable Agent execution, never per harness singleton. */
export interface NativeSessionManagerResolver {
  resolve(context: NativeManagerResolutionContext, owner?: RunOwnership): ResolvedNativeSessionManager
  adoptOwner?(executionId: string, manager: NativeHarnessSessionManager, owner: RunOwnership): void
  release?(context: NativeManagerResolutionContext, manager?: NativeHarnessSessionManager, state?: 'released' | 'failed'): void
}

/** A cold consultation owns a separate process lifetime; its source execution
 * remains completed and cannot be used as a replacement launch authority. */
function managerKey(context: NativeManagerResolutionContext): string {
  if (context.purpose !== 'consultation') {
    if (context.consultation) throw new Error('A consultation binding requires consultation purpose.')
    return context.executionId
  }
  const binding = context.consultation
  if (!binding || binding.runId !== context.runId
    || context.nativeSessionId !== undefined && context.nativeSessionId !== binding.nativeSessionId) {
    throw new Error('The native consultation requires its exact immutable source and retained session.')
  }
  return `consultation:${binding.consultationId}`
}

export class ExecutionScopedNativeSessionManagerResolver implements NativeSessionManagerResolver {
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly entries = new Map<string, {
    context: NativeManagerResolutionContext
    admission: { owner: RunOwnership | undefined; generation: string }
    manager: NativeHarnessSessionManager
    lifecycle: NativeManagerLifecycle
    resolved: ResolvedNativeSessionManager
  }>()

  constructor(private readonly create: (context: NativeManagerResolutionContext,
    getOwner: () => RunOwnership | undefined) => NativeHarnessSessionManager) {}

  resolve(context: NativeManagerResolutionContext, owner?: RunOwnership): ResolvedNativeSessionManager {
    if (this.disposed) throw new Error('Native managers are shutting down.')
    const key = managerKey(context)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.context.agentId !== context.agentId || existing.context.harness !== context.harness
        || existing.context.workingDirectory !== context.workingDirectory
        || existing.context.purpose !== context.purpose
        || !isDeepStrictEqual(existing.context.consultation, context.consultation)
        || existing.context.runId !== context.runId || existing.context.attempt !== context.attempt
        || !isDeepStrictEqual(existing.context.acceptedPlacement, context.acceptedPlacement)
        || !isDeepStrictEqual(existing.context.artifactOutputs, context.artifactOutputs)
        || !isDeepStrictEqual(existing.context.configuration, context.configuration)
        || context.workflowRequest !== undefined && existing.context.workflowRequest !== undefined
          && !isDeepStrictEqual(existing.context.workflowRequest, context.workflowRequest)) {
        throw new Error('A durable execution cannot change native manager ownership context.')
      }
      if (existing.lifecycle === 'failed') throw new Error('The failed native manager is being released.')
      if (owner) {
        owner.assertOwned()
        if (existing.admission.owner && existing.admission.owner.runId !== owner.runId) {
          throw new Error('A durable execution cannot borrow another Run owner.')
        }
        if (existing.admission.owner !== owner) existing.admission.generation = randomUUID()
        existing.admission.owner = owner
      }
      // Restart attachment can allocate before the engine reconstructs the complete request.
      if (context.workflowRequest !== undefined && existing.context.workflowRequest === undefined) {
        existing.context.workflowRequest = structuredClone(context.workflowRequest)
      }
      return existing.resolved
    }
    // Pin plain configuration before passing it to the side-effect-free allocator.
    context = structuredClone(context)
    owner?.assertOwned()
    const admission = { owner, generation: randomUUID() }
    const manager = this.create(context, () => {
      const current = this.entries.get(key)
      // Failed startup still needs its owner to commit cleanup before release.
      return current?.admission === admission
        && (current.lifecycle === 'disposing' || !this.disposed)
        ? admission.owner : undefined
    })
    if (manager.harness !== context.harness) throw new Error('The native manager factory returned the wrong harness.')
    const entry: {
      context: NativeManagerResolutionContext
      admission: { owner: RunOwnership | undefined; generation: string }
      manager: NativeHarnessSessionManager
      lifecycle: NativeManagerLifecycle
      resolved: ResolvedNativeSessionManager
    } = {
      context, admission, manager, lifecycle: 'allocated',
      resolved: {
        manager,
        get processState() { return entry.lifecycle === 'resident' ? 'resident' : 'needs_start' },
        get lifecycle() { return entry.lifecycle },
        beginStart: () => {
          if (this.disposed || this.entries.get(key) !== entry || entry.lifecycle !== 'allocated') {
            throw new Error('The native manager is already starting, resident, or released.')
          }
          entry.lifecycle = 'starting'
        },
        markResident: () => {
          if (this.disposed || this.entries.get(key) !== entry
            || (entry.lifecycle !== 'starting' && entry.lifecycle !== 'resident')) {
            throw new Error('An unstarted or released native manager cannot become resident.')
          }
          entry.lifecycle = 'resident'
        },
        markFailed: () => {
          if (this.entries.get(key) === entry) entry.lifecycle = 'failed'
        },
      },
    }
    this.entries.set(key, entry)
    return entry.resolved
  }

  /** Read-only descendant recovery never allocates or starts a manager. The original Run owner must still be current. */
  residentForRead(executionId: string) {
    const entry = this.entries.get(executionId)
    if (!entry || this.disposed || entry.lifecycle !== 'resident' || !entry.admission.owner) return undefined
    const owner = entry.admission.owner
    if (entry.context.runId !== owner.runId) return undefined
    const generation = entry.admission.generation
    const assertCurrent = () => {
      if (this.disposed || this.entries.get(executionId) !== entry || entry.lifecycle !== 'resident'
        || entry.admission.owner !== owner || entry.admission.generation !== generation) throw new Error('Original native history ownership changed.')
      owner.assertOwned()
    }
    assertCurrent()
    return { manager: entry.manager, context: structuredClone(entry.context), generation, assertCurrent }
  }

  release(context: NativeManagerResolutionContext, manager?: NativeHarnessSessionManager, state: 'released' | 'failed' = 'released'): void {
    const key = managerKey(context)
    const current = this.entries.get(key)
    if (current && current.context.agentId === context.agentId && (!manager || current.manager === manager)) {
      current.lifecycle = state
      current.admission.owner = undefined
      this.entries.delete(key)
    }
  }

  adoptOwner(executionId: string, manager: NativeHarnessSessionManager, owner: RunOwnership): void {
    owner.assertOwned()
    const entry = [...this.entries.values()].find(value => value.context.executionId === executionId && value.manager === manager)
    if (this.disposed || !entry || entry.manager !== manager || entry.context.runId !== owner.runId) {
      throw new Error('The existing native manager does not belong to this Run owner.')
    }
    if (entry.admission.owner !== owner) entry.admission.generation = randomUUID()
    entry.admission.owner = owner
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= Promise.resolve().then(() => Promise.allSettled([...this.entries.entries()].map(async ([executionId, entry]) => {
      const disposable = entry.manager as NativeHarnessSessionManager & { dispose?: () => Promise<void> }
      entry.lifecycle = 'disposing'
      try {
        if (!disposable.dispose) throw new Error('An execution native manager has no disposal contract.')
        await disposable.dispose()
      } catch (error) {
        entry.lifecycle = 'failed'
        throw error
      }
      if (this.entries.get(executionId) === entry) {
        entry.admission.owner = undefined
        entry.lifecycle = 'released'
        this.entries.delete(executionId)
      }
    }))).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Execution native manager disposal was incomplete.')
    })
    const attempt = this.disposal
    void attempt.catch(() => { if (this.disposal === attempt) this.disposal = undefined })
    return attempt
  }
}

export interface AttachedInteractionSession {
  signal?: AbortSignal
  manager: NativeHarnessSessionManager
  session: NativeSessionReference
}

export interface InteractionNativeRuntime {
  withInteractionOwner<T>(interaction: DurableInteraction, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T>
  finishReview?(executionId: string): Promise<void>
  validateInteraction?(interaction: DurableInteraction, signal?: AbortSignal): Promise<void>
  releaseOwnedSession?(context: NativeManagerOwnershipContext, session: NativeSessionReference): Promise<void>
  attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession>
  attachOwnedSession(
    context: NativeManagerOwnershipContext,
    session: NativeSessionReference,
    signal?: AbortSignal,
  ): Promise<AttachedInteractionSession>
}
