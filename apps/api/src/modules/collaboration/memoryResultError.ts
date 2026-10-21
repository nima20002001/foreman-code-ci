import { DomainError } from '../errors.js'

/** A valid native envelope whose requested memory effects need correction. */
export class MemoryResultRejected extends DomainError {
  constructor(error: DomainError) {
    super(error.code, error.message, error.status, error.details, { cause: error })
  }
}
