import { DomainError } from '../errors.js'

export class DeviceAccessError extends DomainError {
  constructor(readonly code: 'unauthorized' | 'revoked' | 'expired' | 'conflict' | 'forbidden' | 'wrong_main') { super(code, `Device access rejected: ${code}`, 403) }
}
