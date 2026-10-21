import pg from 'pg'

export function createTestPool(options) {
  const pool = new pg.Pool(options)
  const connections = new Set()
  pool.on('connect', client => {
    const closed = new Promise(resolve => client.once('end', () => {
      connections.delete(closed)
      resolve()
    }))
    connections.add(closed)
  })
  const end = pool.end.bind(pool)
  pool.end = callback => {
    // pg-pool removes clients from its count before their sockets finish closing.
    const closed = end().then(() => Promise.all([...connections])).then(() => undefined)
    if (!callback) return closed
    closed.then(() => callback(), callback)
  }
  pool.on('error', error => {
    // Administrative termination is expected only once shutdown has started.
    if (pool.ending && error.code === '57P01') return
    throw error
  })
  return pool
}
