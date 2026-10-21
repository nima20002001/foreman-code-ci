import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import {
  ProviderAccountBindingSchema, ProviderAccountObservationSchema, ProviderAccountAuthenticationOperationSchema, ProviderAccountNativeAuthenticationObservationSchema,
  type ProviderAccountBinding, type ProviderAccountObservation, type ProviderAccountAuthenticationOperation, type ProviderAccountNativeAuthenticationObservation,
} from '@foreman-code/contracts/provider-accounts'
import { DomainError } from '../errors.js'
import { privateDirectory, readRecord, recordObject, syncDirectory, writeRecord } from '../harnesses/recovery/storage.js'

export interface NativeAccountRecord {
  operation: ProviderAccountAuthenticationOperation
  observation: ProviderAccountNativeAuthenticationObservation
  owner: string
  launchId?: string
  dispatched: boolean
}

function operationIdentity(operation: ProviderAccountAuthenticationOperation): unknown {
  return { id: operation.id, commandId: operation.commandId, inputHash: operation.inputHash,
    binding: operation.binding, intent: operation.intent, generation: operation.generation,
    createdAt: operation.createdAt, expiresAt: operation.expiresAt }
}

export class NativeAccountJournal {
  private readonly root: string
  constructor(root: string) { this.root = privateDirectory(root) }

  owner(operation: Pick<ProviderAccountAuthenticationOperation, 'binding'>): string {
    const key = createHash('sha256').update(JSON.stringify([
      operation.binding.target, operation.binding.provider, operation.binding.accountId,
    ])).digest('hex')
    return `provider-account:${key}`
  }

  private operationPath(id: string): string {
    ProviderAccountAuthenticationOperationSchema.shape.id.parse(id)
    return join(this.root, `${id}.json`)
  }

  private slotPath(operation: Pick<ProviderAccountAuthenticationOperation, 'binding'>): string {
    return join(this.root, `${this.owner(operation).replace(':', '-')}.json`)
  }

  accountGeneration(binding: Readonly<DeviceSessionBinding>): number {
    const path = join(this.root, 'generation.json')
    const raw = readRecord(path)
    // The timestamp also advances observations written before this counter was persisted.
    let generation = Math.max(Date.now(), binding.connectionGeneration)
    if (raw !== undefined) {
      const previous = recordObject(raw)
      const savedBinding = DeviceSessionBindingSchema.parse(previous.binding)
      const savedGeneration = ProviderAccountObservationSchema.shape.generation.parse(previous.generation)
      if (isDeepStrictEqual(savedBinding, binding)) return savedGeneration
      generation = Math.max(generation, savedGeneration + 1)
    }
    writeRecord(path, { binding, generation })
    return generation
  }

  nextObservationSequence(binding: ProviderAccountBinding): number {
    binding = { ...binding, subject: null }
    const path = join(this.root, `${binding.provider}-${binding.accountId}-sequence.json`)
    const previous = readRecord(path)
    let sequence = Date.now()
    const observed = readRecord(join(this.root, `${binding.provider}-${binding.accountId}-observation.json`))
    if (observed !== undefined) {
      const saved = recordObject(observed)
      if (!isDeepStrictEqual({ ...ProviderAccountBindingSchema.parse(saved.binding), subject: null }, binding)) throw new DomainError(
        'PROVIDER_OBSERVATION_STALE', 'The saved observation belongs to another account binding.', 409)
      sequence = Math.max(sequence, ProviderAccountObservationSchema.parse(saved.observation).sequence + 1)
    }
    if (previous !== undefined) {
      const record = recordObject(previous)
      if (!isDeepStrictEqual({ ...ProviderAccountBindingSchema.parse(record.binding), subject: null }, binding)
        || !Number.isSafeInteger(record.sequence) || Number(record.sequence) < 0) {
        throw new DomainError('PROVIDER_OBSERVATION_STALE', 'The account observation sequence belongs to another binding.', 409)
      }
      sequence = Math.max(sequence, Number(record.sequence) + 1)
    }
    writeRecord(path, { binding, sequence })
    return sequence
  }

  saveObservation(binding: ProviderAccountBinding, raw: ProviderAccountObservation): ProviderAccountObservation {
    binding = { ...binding, subject: null }
    const observation = ProviderAccountObservationSchema.parse(raw)
    if (binding.bindingRevision !== observation.bindingRevision) throw new DomainError(
      'PROVIDER_OBSERVATION_STALE', 'The observation belongs to another account binding revision.', 409)
    const path = join(this.root, `${binding.provider}-${binding.accountId}-observation.json`)
    const previous = readRecord(path)
    if (previous !== undefined) {
      const record = recordObject(previous)
      const old = ProviderAccountObservationSchema.parse(record.observation)
      if (!isDeepStrictEqual({ ...ProviderAccountBindingSchema.parse(record.binding), subject: null }, binding)
        || observation.generation < old.generation) throw new DomainError(
          'PROVIDER_OBSERVATION_STALE', 'The saved native observation uses another account or generation.', 409)
      if (observation.generation === old.generation && observation.sequence <= old.sequence) return old
    }
    const next = observation
    writeRecord(path, { binding, observation: next })
    return next
  }

  accountOperation(binding: ProviderAccountBinding): NativeAccountRecord | undefined {
    const holder = readRecord(this.slotPath({ binding }))
    if (holder === undefined) return undefined
    const record = this.read(String(recordObject(holder).operationId))
    if (!record || !isDeepStrictEqual({ ...record.operation.binding, subject: null }, { ...binding, subject: null })) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The local account operation uses another binding.', 409)
    }
    return record
  }

  read(id: string): NativeAccountRecord | undefined {
    const raw = readRecord(this.operationPath(id))
    if (raw === undefined) return undefined
    const record = recordObject(raw)
    const operation = ProviderAccountAuthenticationOperationSchema.parse(record.operation)
    const observation = ProviderAccountNativeAuthenticationObservationSchema.parse(record.observation)
    if (operation.id !== id || observation.operationId !== id || record.owner !== this.owner(operation)
      || !isDeepStrictEqual(operation.binding, observation.binding) || operation.generation !== observation.generation
      || typeof record.dispatched !== 'boolean'
      || record.launchId !== undefined && !ProviderAccountAuthenticationOperationSchema.shape.id.safeParse(record.launchId).success) {
      throw new DomainError('PROVIDER_OPERATION_INVALID', 'The saved native account operation is invalid.', 409)
    }
    return { operation, observation, owner: String(record.owner), dispatched: record.dispatched,
      ...(record.launchId ? { launchId: String(record.launchId) } : {}) }
  }

  reserve(raw: ProviderAccountAuthenticationOperation): { record: NativeAccountRecord; created: boolean } {
    const operation = ProviderAccountAuthenticationOperationSchema.parse(raw)
    const identityPath = join(this.root, `${operation.binding.provider}-${operation.binding.accountId}-binding.json`)
    const previousBinding = readRecord(identityPath)
    if (previousBinding !== undefined) {
      if (!isDeepStrictEqual(ProviderAccountBindingSchema.parse(previousBinding), operation.binding)) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The local slot belongs to another accepted installation or profile.', 409)
      }
    } else {
      try { writeRecord(identityPath, operation.binding, true) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!isDeepStrictEqual(ProviderAccountBindingSchema.parse(readRecord(identityPath)), operation.binding)) {
          throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Another installation owns this account slot.', 409, undefined, { cause: error })
        }
      }
    }
    const existing = this.read(operation.id)
    if (existing) {
      if (!isDeepStrictEqual(operationIdentity(existing.operation), operationIdentity(operation))) {
        throw new DomainError('PROVIDER_OPERATION_CONFLICT', 'The original account operation input changed.', 409)
      }
      return { record: existing, created: false }
    }
    const slotPath = this.slotPath(operation)
    const holder = readRecord(slotPath)
    if (holder !== undefined) {
      const previous = this.read(String(recordObject(holder).operationId))
      if (!previous?.observation.nativeClosed) throw new DomainError('PROVIDER_LOGIN_PENDING',
        'An earlier account operation still owns this slot.', 409)
      unlinkSync(slotPath)
      syncDirectory(this.root)
    }
    try { writeRecord(slotPath, { operationId: operation.id }, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new DomainError('PROVIDER_LOGIN_PENDING', 'Another account operation owns this slot.', 409, undefined, { cause: error })
    }
    const record: NativeAccountRecord = { operation, owner: this.owner(operation), dispatched: false,
      observation: { operationId: operation.id, binding: operation.binding, generation: operation.generation,
        sequence: 0, state: 'reserved', nativeClosed: false } }
    writeRecord(this.operationPath(operation.id), record, true)
    return { record, created: true }
  }

  write(record: NativeAccountRecord): void {
    const existing = this.read(record.operation.id)
    if (!existing || !isDeepStrictEqual(operationIdentity(existing.operation), operationIdentity(record.operation))) {
      throw new DomainError('PROVIDER_OPERATION_CONFLICT', 'The saved account operation changed.', 409)
    }
    ProviderAccountNativeAuthenticationObservationSchema.parse(record.observation)
    writeRecord(this.operationPath(record.operation.id), record)
  }
}
