import { testAdminUrl } from './test-resources.mjs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const pg = require('pg')
const installed = Symbol.for('graphql.test.postgres.guard')

export function installTestConnectionGuard() {
  if (pg.Client.prototype[installed]) return
  const connect = pg.Client.prototype.connect
  pg.Client.prototype.connect = function (callback) {
    const connection = this.connectionParameters
    const expected = new URL(testAdminUrl)
    const allowed = connection.host === expected.hostname && Number(connection.port) === Number(expected.port)
      && connection.user === expected.username && connection.password === expected.password
    if (!allowed) {
      const error = new Error('Test PostgreSQL connections must use the dedicated disposable test instance')
      if (callback) {
        queueMicrotask(() => callback(error))
        return
      }
      return Promise.reject(error)
    }
    return connect.call(this, callback)
  }
  pg.Client.prototype[installed] = true
}

installTestConnectionGuard()
