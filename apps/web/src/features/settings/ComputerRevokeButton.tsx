import { useRef } from 'react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { useRevokeComputer } from '../../shared/api/computerSettings'
import { ApiError } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { Button } from '../../shared/ui/nocturne'

export function ComputerRevokeButton({ registration }: { registration: DeviceRegistration }) {
  const revoke = useRevokeComputer()
  type Input = Omit<Parameters<typeof revoke.mutateAsync>[0], 'commandId'>
  const attempt = useRef(new CommandAttempt<Input>()).current
  const original = useRef<Input | undefined>(undefined)
  const submit = async () => {
    const hadUnknownOutcome = attempt.unresolved
    original.current ??= { deviceId: registration.deviceId, expectedRevision: registration.authorizationRevision }
    try {
      await revoke.mutateAsync(attempt.input(original.current))
      attempt.succeeded(); original.current = undefined
    } catch (error) {
      const reconciliationDenied = hadUnknownOutcome && error instanceof ApiError
        && (error.status === 401 || error.status === 403) && error.code !== 'conflict'
      if (!reconciliationDenied) attempt.failed(error)
      if (!attempt.unresolved) original.current = undefined
    }
  }
  return <div>
    <UnsavedEditorGuard editor={{ label: 'computer revoke command', dirty: attempt.unresolved, busy: revoke.isPending, uncertain: attempt.unresolved,
      save: submit, discard: () => { if (!attempt.unresolved) revoke.reset() }, error: revoke.error?.message }} />
    <p>Revoking application access blocks future authenticated connections. It does not prove an unreachable worker process has stopped.</p>
    <Button disabled={revoke.isPending || (!attempt.unresolved && registration.status === 'revoked')} onClick={() => void submit()}>
      {revoke.isPending ? 'Revoking…' : attempt.unresolved ? 'Reconcile original revoke command' : 'Revoke worker access'}
    </Button>
    {revoke.error ? <p role="alert">{revoke.error.message}</p> : null}
    {revoke.isSuccess ? <p role="status">Application access revoked.</p> : null}
  </div>
}
