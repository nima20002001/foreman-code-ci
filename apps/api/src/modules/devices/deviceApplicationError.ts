import type { DeviceApplicationFailure } from '@foreman-code/contracts/device-application'
import {
  explicitFailureClass, isTransientDatabaseOrSocketError, type FailureClass,
} from '@foreman-code/contracts/failure'
import { WorkerBundleReadinessSchema, type WorkerBundleReadiness } from '@foreman-code/contracts/computer-maintenance'

/** The class of each code a device peer may send; it is authoritative over what the error states about itself. */
const classes: Readonly<Record<string, FailureClass>> = {
  'extension-rejected': 'permanent',
  WORKER_UPDATE_SMOKE_UNAVAILABLE: 'transient',
  WORKER_RELEASE_ASSET_UNAVAILABLE: 'transient',
  WORKER_VERSION_SKEW: 'transient',
  WORKER_BUNDLE_UNPUBLISHED: 'transient',
  WORKER_UPDATING: 'transient',
  WORKER_RUNTIME_DRAINING: 'transient',
  CI_HOST_BUSY: 'transient',
  MCP_INSPECTION_CONTEXT_MISMATCH: 'permanent',
  MCP_PRESET_UNAVAILABLE: 'permanent',
  MCP_PRESET_CUSTOMIZED: 'permanent',
  MCP_SERVER_EXISTS: 'permanent',
  MCP_RECONCILIATION_REQUIRED: 'permanent',
  MCP_RECONCILIATION_MISMATCH: 'permanent',
  MCP_PLAN_NOT_FOUND: 'permanent',
  COMMAND_ID_CONFLICT: 'permanent',
  REVISION_CONFLICT: 'permanent',
  SYNC_UNAVAILABLE: 'transient',
  COMPUTER_GITHUB_REQUIRED: 'permanent',
  COMPUTER_ACCOUNT_UNAVAILABLE: 'transient',
  GITHUB_STATUS_UNKNOWN: 'transient',
  CI_RUN_UNKNOWN: 'permanent',
  GITHUB_ACCOUNT_CHANGED: 'permanent',
  GITHUB_LOGIN_NOT_FOUND: 'permanent',
  GITHUB_CLI_MISSING: 'permanent',
  GITHUB_LOGIN_CANCELLED: 'permanent',
  GITHUB_LOGIN_FAILED: 'permanent',
  GITHUB_SETUP_NOT_READY: 'permanent',
  GITHUB_LOGOUT_FAILED: 'permanent',
  unavailable: 'transient',
  backpressure: 'transient',
  DEVICE_BUSY: 'transient',
  timeout: 'transient',
  transport: 'transient',
  DATABASE_READ_TIMEOUT: 'transient',
  cancelled: 'cancelled',
  'payload-too-large': 'permanent',
  authentication: 'permanent',
  permission: 'permanent',
  unauthorized: 'permanent',
  revoked: 'permanent',
  expired: 'permanent',
  conflict: 'permanent',
  forbidden: 'permanent',
  wrong_main: 'permanent',
  'job-output-expired': 'permanent',
  'transfer-expired': 'permanent',
  'job-publication-pending': 'transient',
  'source-repository-timeout': 'transient',
  'source-repository-uncertain': 'permanent',
  AUTH_REVOKED: 'permanent',
  AUTH_RUN_ENDED: 'permanent',
  REMOTE_AUTHORITY_DENIED: 'permanent',
  REMOTE_REVIEWER_DENIED: 'permanent',
  REVIEWER_BINDING_REBIND_REQUIRED: 'transient',
  REMOTE_CONTROL_UNAVAILABLE: 'permanent',
  REMOTE_DISPATCH_UNAVAILABLE: 'transient',
  DEVICE_LINK_DROPPED: 'transient',
  REMOTE_BINDING_CONFLICT: 'permanent',
  REMOTE_OBSERVATION_NOT_AUTHENTICATED: 'permanent',
  REMOTE_NATIVE_PHYSICAL_UNAVAILABLE: 'transient',
  REMOTE_NATIVE_PHYSICAL_BACKPRESSURE: 'transient',
  REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED: 'transient',
  REMOTE_NATIVE_SOURCE_NOT_CAPTURED: 'permanent',
  REMOTE_NATIVE_SOURCE_BACKPRESSURE: 'transient',
  REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE: 'permanent',
  NATIVE_ARTIFACT_AUTHORITY_DENIED: 'permanent',
  NATIVE_ARTIFACT_CONTEXT_PENDING: 'transient',
  WORKER_WORKFLOW_UNAVAILABLE: 'transient',
  HARNESS_INVENTORY_STALE: 'transient',
  HARNESS_QUALIFICATION_TARGET_CHANGED: 'transient',
  WORKER_EXECUTION_NOT_FOUND: 'permanent',
  WORKER_EXECUTION_IDENTITY_INVALID: 'permanent',
  PLACEMENT_INVALID_ROOT: 'permanent',
  PLACEMENT_BINDING_CONFLICT: 'permanent',
  PLACEMENT_ADMISSION_CONFLICT: 'permanent',
  PLACEMENT_PREPARATION_REQUIRED: 'permanent',
  PLACEMENT_MAIN_MISMATCH: 'permanent',
  PLACEMENT_CONFLICT: 'permanent',
  EXECUTION_PLACEMENT_CONFLICT: 'permanent',
  SOURCE_OPERATION_AUTHORITY_CONFLICT: 'permanent',
  SOURCE_CONNECTION_CONFLICT: 'permanent',
  SOURCE_ATTEMPT_CONFLICT: 'permanent',
  ROOT_DIRECTORY_MISSING: 'permanent',
  ROOT_RELATIVE_PATH_INVALID: 'permanent',
  ROOT_ACCESS_DENIED: 'permanent',
  ROOT_CONFIGURATION_CONFLICT: 'permanent',
  ROOT_BASE_CHANGED: 'permanent',
  ROOT_DIRECTORY_CHANGED: 'permanent',
  ROOT_RUNTIME_CHANGED: 'permanent',
  ROOT_FILESYSTEM_UNSUPPORTED: 'permanent',
  ROOT_RUNTIME_OVERLAP: 'permanent',
  SOURCE_ROOT_NOT_PRIVATE: 'permanent',
  SOURCE_FILESYSTEM_UNSUPPORTED: 'permanent',
  EACCES: 'permanent',
  EPERM: 'permanent',
  ELOOP: 'permanent',
  ENOENT: 'permanent',
  ENOTDIR: 'permanent',
  SOURCE_CLAIM_MISSING: 'permanent',
  SOURCE_CAPACITY: 'permanent',
  SOURCE_DISK_CAPACITY: 'permanent',
  SOURCE_REPOSITORY_TIMEOUT: 'transient',
  SOURCE_REPOSITORY_UNCERTAIN: 'permanent',
  'source-reconciliation-unconfirmed': 'transient',
  SOURCE_RECLAMATION_UNCONFIRMED: 'permanent',
  SOURCE_EXECUTION_UNCERTAIN: 'transient',
  SOURCE_PREPARATION_ACTIVE: 'transient',
  SOURCE_PREPARATION_RECONCILED: 'permanent',
  SOURCE_QUOTA_MISSING: 'permanent',
  SOURCE_ROOT_CHANGED: 'permanent',
  SOURCE_CLAIM_INVALID: 'permanent',
  SOURCE_CLAIM_CONFLICT: 'permanent',
}

const readinessCodes = new Set(['WORKER_VERSION_SKEW', 'WORKER_BUNDLE_UNPUBLISHED', 'WORKER_UPDATING'])
const failure = (code: string, failureClass: FailureClass, details?: WorkerBundleReadiness): DeviceApplicationFailure =>
  ({ code, class: failureClass, retryable: failureClass === 'transient', ...(details ? { details } : {}) })

/** The failure a device reply carries. Only listed codes cross the channel, with their listed class; an unlisted error
 * that states its class keeps it under a redacted code, so a transient failure stays transient. Unclassified unlisted
 * codes are rejections. */
export function deviceApplicationFailure(error: unknown): DeviceApplicationFailure {
  // A handler whose own deadline fired (Node's TimeoutError has a numeric code) is transient, not a rejection.
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'TimeoutError') {
    return failure('timeout', 'transient')
  }
  const proposed = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  // Losing a cached reply requires a fresh observation of the same process, not another execution attempt.
  if (proposed === 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'
    && (error as { details?: { reason?: unknown } }).details?.reason === 'not_retained') {
    return failure('REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', 'transient')
  }
  if (typeof proposed === 'string' && Object.hasOwn(classes, proposed)) {
    const details = readinessCodes.has(proposed)
      ? WorkerBundleReadinessSchema.safeParse((error as { details?: unknown }).details) : undefined
    return failure(proposed, classes[proposed]!, details?.success ? details.data : undefined)
  }
  const explicit = explicitFailureClass(error)
  if (explicit === 'permanent') return failure('extension-rejected', 'permanent')
  if (explicit) return failure(explicit === 'cancelled' ? 'cancelled' : 'unavailable', explicit)
  if (isTransientDatabaseOrSocketError(error)) return failure('unavailable', 'transient')
  return failure('extension-rejected', 'permanent')
}

export class DeviceApplicationError extends Error {
  readonly code: string
  readonly class: FailureClass
  readonly retryable: boolean
  readonly details: WorkerBundleReadiness | undefined
  // Plain fields, not parameter properties: Worker code loads this file through Node's type stripping.
  constructor(code: string, details?: WorkerBundleReadiness, options?: ErrorOptions & { class?: FailureClass }) {
    super(code, options)
    this.code = code
    this.details = details
    this.class = options?.class ?? deviceApplicationFailure({ code }).class
    this.retryable = this.class === 'transient'
  }
}

/** The request was refused before its domain handler could run. */
export class DeviceApplicationAdmissionError extends DeviceApplicationError {
  readonly reason: string

  constructor(reason = 'backpressure') {
    super('backpressure')
    this.reason = reason
  }
}
