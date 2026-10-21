import type pg from 'pg'
import { withExclusiveGraphConnection } from '../run-graph/connection.js'
import { MemoryBoardService } from './service.js'
import type { MemoryBoardAuthority } from './types.js'
import { postgresMemoryBoardListener } from './notifications.js'

export { postgresMemoryBoardListener } from './notifications.js'
export function createMemoryBoardService(pool: pg.Pool, authority: MemoryBoardAuthority): MemoryBoardService {
  return new MemoryBoardService({ authority,
    transaction: work => withExclusiveGraphConnection(pool,connection => connection.transaction(work)),
    readTransaction: work => withExclusiveGraphConnection(pool,connection => connection.transaction(work,true)),
    listen:postgresMemoryBoardListener(pool),
  })
}
