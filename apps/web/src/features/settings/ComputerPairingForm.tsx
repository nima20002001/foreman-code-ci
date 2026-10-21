import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { DeviceSetupApproveInputSchema, decodeWorkerIdentityRequest } from '@foreman-code/contracts/device-setup'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { useApproveComputerSetup, useComputerSetupOptionsQuery, useRegisteredComputersQuery, useSelectedMainQuery } from '../../shared/api/computerSettings'
import { ApiError } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { TextField, Textarea, Button } from '../../shared/ui/nocturne'
import { DeviceSetupGuide } from './DeviceSetupGuide'

const unavailable = {
  'listener-unconfigured': 'This main has no computer listener configured. Configure the LAN device listener on the main, then reload this page.',
  'endpoint-unconfigured': 'This main has no LAN device address configured. Set the approved LAN device endpoint on the main, then reload this page.',
  'listener-not-started': 'The computer listener on this main is not running. Start it, then reload this page.',
} as const
const usePairingDraft = create<{ code: string; expired: boolean; expire(): void; set(code: string): void; clear(): void }>(set => ({
  code: '', expired: false,
  expire: () => set({ expired: true }),
  set: code => set({ expired: false, code }),
  clear: () => set({ expired: false, code: '' }),
}))
/** This form never installs or logs in. The private pairing code lives only in the mutation result
 * until expiry/unmount, and is never put in the URL, a query cache or persistence. */
export function ComputerPairingForm({ mainId }: { mainId: string }) {
  const code = usePairingDraft(state => state.code)
  const update = usePairingDraft(state => state.set)
  const expired = usePairingDraft(state => state.expired)
  const expire = usePairingDraft(state => state.expire)
  const clear = usePairingDraft(state => state.clear)
  const options = useComputerSetupOptionsQuery(mainId)
  const main = useSelectedMainQuery()
  const approval = useApproveComputerSetup(mainId)
  const computers = useRegisteredComputersQuery(mainId)
  const reset = approval.reset
  type Input = Omit<Parameters<typeof approval.mutateAsync>[0], 'commandId'>
  const attempt = useRef(new CommandAttempt<Input>()).current
  const original = useRef<Input | undefined>(undefined)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState<'done' | 'blocked'>()
  const [resultTarget, setResultTarget] = useState<Pick<DeviceRegistration, 'deviceId' | 'authorizationRevision'>>()
  useEffect(() => {
    clear()
    setResultTarget(undefined)
    return () => { clear(); reset() }
  }, [mainId, clear, reset])
  useEffect(() => {
    if (!approval.data) return
    const timer = setTimeout(() => { reset(); expire(); setRevealed(false); setCopied(undefined) }, Math.max(0, Date.parse(approval.data.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [approval.data, reset, expire])
  const identity = (() => { try { return code.trim() ? decodeWorkerIdentityRequest(code) : undefined } catch { return null } })()
  const endpoint = options.data?.available ? options.data.endpoint : null
  const mainFingerprint = main.data?.mainId === mainId ? main.data.mainPublicKeyFingerprint : undefined
  const existing = identity && computers.isSuccess
    ? computers.data.devices.find(value => value.workerInstallationId === identity.workerInstallationId) : undefined
  const canEnroll = computers.isSuccess && !computers.isFetching && (!existing || existing.status === 'revoked')
  const input: Input | undefined = identity && endpoint && mainFingerprint && canEnroll
    ? { identityRequestCode: code.trim(), endpoint, scopes: ['connect', 'heartbeat'],
      ...(existing ? { expectedAuthorizationRevision: existing.authorizationRevision } : {}) } : undefined
  const currentRegistration = resultTarget ? computers.data?.devices.find(value => value.deviceId === resultTarget.deviceId
    && value.authorizationRevision >= resultTarget.authorizationRevision) : undefined
  const resultRegistration = currentRegistration ?? approval.data?.registration
  const hasResult = Boolean(approval.data || resultRegistration)
  const paired = resultRegistration?.status === 'paired'
  const revoked = resultRegistration?.status === 'revoked'
  const superseded = resultRegistration?.status === 'pending' && resultTarget !== undefined
    && resultRegistration.authorizationRevision > resultTarget.authorizationRevision
  const codeAvailable = approval.data !== undefined && resultRegistration?.status === 'pending'
    && resultRegistration.authorizationRevision === approval.data.registration.authorizationRevision
  const locked = approval.isPending || attempt.unresolved || hasResult
  const submit = async () => {
    const hadUnknownOutcome = attempt.unresolved
    try {
      const request = attempt.input(original.current ?? input!)
      DeviceSetupApproveInputSchema.parse(request)
      original.current ??= input
      const result = await approval.mutateAsync(request)
      setResultTarget({ deviceId: result.registration.deviceId, authorizationRevision: result.registration.authorizationRevision })
      attempt.succeeded()
      original.current = undefined
    } catch (error) {
      const reconciliationDenied = hadUnknownOutcome && error instanceof ApiError
        && (error.status === 401 || error.status === 403) && error.code !== 'conflict'
      if (!reconciliationDenied) attempt.failed(error)
      if (!attempt.unresolved) original.current = undefined
      if (error instanceof ApiError && error.code === 'conflict') await computers.refetch()
    }
  }
  const copy = async () => {
    if (!codeAvailable || !approval.data) return
    try { await navigator.clipboard.writeText(approval.data.enrollmentCode); setCopied('done') } catch { setCopied('blocked') }
  }
  let approvalLabel = 'Approve this computer'
  if (attempt.unresolved) approvalLabel = 'Reconcile original pairing command'
  if (approval.isPending) approvalLabel = 'Approving…'
  let resultMessage = 'Computer pending; waiting for the computer to finish pairing.'
  if (paired) resultMessage = 'Computer paired.'
  if (revoked) resultMessage = 'Computer access revoked. Its previous pairing code can no longer be used.'
  if (superseded) resultMessage = 'Computer pairing is pending from a newer approval. This request’s pairing code can no longer be used.'
  return <section aria-label="Add computer">
    <UnsavedEditorGuard editor={{ label: 'computer pairing command', dirty: attempt.unresolved, busy: approval.isPending, uncertain: attempt.unresolved,
      save: submit, discard: () => { if (!attempt.unresolved) reset() }, error: approval.error?.message }} />
    <h2 className="computers-title">Add computer</h2>
    <DeviceSetupGuide />
    <ol className="computer-steps">
      <li>Open the installed companion on the computer and copy its request code.</li>
      <li>Paste the code here and approve the computer.</li>
      <li>Enter the private pairing code you get into the companion.</li>
    </ol>
    {options.isPending ? <p role="status">Reading computer setup configuration…</p> : null}
    {options.error ? <p role="alert">{options.error.message}</p> : null}
    {options.data && !options.data.available ? <div role="alert" className="computer-unavailable">
      <p>Adding a computer isn’t available yet. This main needs setup before it can accept one; the code can’t be approved until then.</p>
      <details className="computer-details"><summary>Technical details</summary>
        <p>{options.data.reason ? unavailable[options.data.reason] : 'Computer setup is unavailable.'}</p></details></div> : null}
    {main.error ? <p role="alert">{main.error.message}</p> : null}
    {main.data && main.data.mainId !== mainId ? <p role="alert">The selected main changed. Reload this page.</p> : null}
    <Textarea label="Computer request code" value={code} disabled={locked} autoComplete="off" spellCheck={false} onChange={event => update(event.target.value)} />
    {identity === null ? <p role="alert">This is not a valid computer request code. Copy it again from the companion.</p> : null}
    {identity && !hasResult ? <details className="computer-details" open>
      <summary>Confirm details</summary>
      <dl className="computer-facts">
        <div><dt>Computer ID</dt><dd>{identity.workerInstallationId}</dd></div>
        <div><dt>Computer key fingerprint</dt><dd>{identity.publicKeyFingerprint}</dd></div>
        <div><dt>This main · fingerprint</dt><dd>{mainFingerprint ?? 'Reading…'}</dd></div>
        <div><dt>Device endpoint</dt><dd>{endpoint ?? 'Unavailable'}</dd></div>
        <div><dt>Access</dt><dd>Connect and heartbeat only. This does not approve remote commands.</dd></div>
        {existing?.status === 'revoked' ? <div><dt>Re-enrollment</dt><dd>This installation’s access was revoked. Confirm the fingerprints before approving access again.</dd></div> : null}
      </dl>
    </details> : null}
    {existing && existing.status !== 'revoked' && !hasResult && !attempt.unresolved
      ? <p role="status">This installation is already {existing.status}. Revoke its existing access before requesting a new pairing code.</p> : null}
    {computers.error ? <p role="alert">{computers.error.message}</p> : null}
    {expired && !paired && !revoked && !superseded ? <p role="status">The one-use pairing code expired. Read the computer status before requesting a fresh code.</p> : null}
    {approval.error ? <p role="alert">{approval.error.message}</p> : null}
    {!hasResult ? <div className="computer-actions"><Button variant="primary" disabled={approval.isPending || (!original.current && !input)}
      onClick={() => void submit()}>{approvalLabel}</Button></div> : <div className="computer-pairing-result">
      <p role="status">{resultMessage}
        {codeAvailable && approval.data ? <> Pairing code expires <time dateTime={approval.data.expiresAt}>{approval.data.expiresAt}</time>.</> : null}</p>
      {codeAvailable && approval.data ? <>
        <TextField label="Private pairing code · secret" type={revealed ? 'text' : 'password'} readOnly autoComplete="off" value={approval.data.enrollmentCode} />
        <div className="computer-actions"><Button onClick={() => setRevealed(value => !value)}>{revealed ? 'Hide pairing code' : 'Show pairing code'}</Button>
        <Button onClick={() => void copy()}>Copy pairing code</Button></div>
        {copied ? <p role="status">{copied === 'done' ? 'Copied. Paste it into the companion.' : 'Copy was blocked. Show the code and copy it manually.'}</p> : null}
      </> : null}
      <Button onClick={() => { reset(); clear(); setResultTarget(undefined); setRevealed(false); setCopied(undefined) }}>{paired || revoked || superseded ? 'Done' : 'Discard pairing code'}</Button>
    </div>}
  </section>
}
