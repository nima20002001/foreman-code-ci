import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'

// Native delivery already holds the Stop transaction. Lane fencing must use
// that connection rather than waiting for another slot in the same pool.
export const interactionConnection = new AsyncLocalStorage<pg.PoolClient>()
