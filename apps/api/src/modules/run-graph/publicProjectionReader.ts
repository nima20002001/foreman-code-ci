import type { PublicGraphProjection, RunGraphScope } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'

export interface PublicProjectionReader {
  (sql: GraphTransactionSql, scope: RunGraphScope): Promise<PublicGraphProjection>
}
