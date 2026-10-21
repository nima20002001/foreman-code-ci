import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ProviderAccountBinding, ProviderAccountObservation } from '@foreman-code/contracts/provider-accounts'
import { ownedTestPath } from '../../../test/helpers/testResources.js'
import { NativeAccountJournal } from './nativeJournal.js'

it('orders native observations across restart and accepted subject capture without rebinding the slot', async () => {
  const root = ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `account-observations-${randomUUID()}`))
  try {
    const id = randomUUID()
    const mainId = randomUUID()
    const binding: ProviderAccountBinding = { kind: 'slot', provider: 'codex', accountId: id, profileRef: id,
      bindingRevision: 1, subject: null, target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        keyRevision: null, authorizationRevision: null } }
    const journal = new NativeAccountJournal(root)
    const sequence = journal.nextObservationSequence(binding)
    const subject = { subject: 'qualified-subject', provenance: 'qualified-native' as const,
      qualificationId: 'storage-proof', observedAt: '2026-01-01T00:00:00.000Z' }
    const observed: ProviderAccountObservation = { bindingRevision: 1, generation: 2, sequence,
      observedAt: subject.observedAt, status: 'signed-in', identity: null, subject, readiness: 'unknown' }
    expect(journal.saveObservation(binding, observed)).toEqual(observed)
    const accepted = { ...binding, subject }
    const recovered = new NativeAccountJournal(root)
    const next = recovered.nextObservationSequence(accepted)
    expect(next).toBeGreaterThan(sequence)
    expect(recovered.saveObservation(accepted, { ...observed, sequence: next }).subject).toEqual(subject)
    expect(recovered.saveObservation(binding, observed).sequence).toBe(next)
    expect(() => recovered.nextObservationSequence({ ...accepted, bindingRevision: 2 }))
      .toThrow('another account binding')
    expect(binding.subject).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})
