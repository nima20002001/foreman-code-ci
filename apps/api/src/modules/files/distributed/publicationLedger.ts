import type pg from 'pg'
import { VerifiedTransferReceiptSchema, type VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import type { PublicationLink } from '../tools/types.js'
import { PostgresFileToolRepository } from '../tools/postgres.js'
import { DomainError } from '../../errors.js'

export interface DistributedPublicationLink extends PublicationLink {
  transferReceipt: VerifiedTransferReceipt
  publicationInputHash: string
}
export interface DistributedPublicationLedger {
  read(ownerPrincipalId: string, requestId: string): Promise<DistributedPublicationLink | undefined>
  linkPublication(link: DistributedPublicationLink): Promise<void>
}
/** Extension of the existing ledger record, no second publication table or allocation identity. */
export class PostgresDistributedPublicationLedger implements DistributedPublicationLedger {
  private readonly ledger: PostgresFileToolRepository
  constructor(private readonly pool: pg.Pool) { this.ledger = new PostgresFileToolRepository(pool) }
  async read(owner: string, request: string): Promise<DistributedPublicationLink | undefined> {
    const result = await this.pool.query<{ record: DistributedPublicationLink }>(`select record from file_tool_publications
      where owner_principal_id=$1 and request_id=$2`, [owner, request])
    const link = result.rows[0]?.record
    if (!link) return undefined
    if (!link.publicationInputHash || !link.transferReceipt) {
      throw new DomainError('FILE_PUBLICATION_CONFLICT', 'The publication belongs to another operation.', 409)
    }
    return { ...link, transferReceipt: VerifiedTransferReceiptSchema.parse(link.transferReceipt) }
  }
  async linkPublication(link: DistributedPublicationLink): Promise<void> {
    await this.ledger.linkPublication(link)
    const stored = await this.read(link.ownerPrincipalId, link.requestId)
    if (!stored || stored.publicationInputHash !== link.publicationInputHash
      || stored.transferReceipt.receiptId !== link.transferReceipt.receiptId) {
      throw new DomainError('FILE_REQUEST_CONFLICT', 'The original publication receipt identifies different input.', 409)
    }
  }
}
