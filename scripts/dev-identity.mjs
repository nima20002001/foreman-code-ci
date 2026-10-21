export function apiIdentityMatches(expected) {
  return (response, body) => {
    try {
      const actual = JSON.parse(body)
      return response.ok && ['installationId', 'checkoutId', 'databaseId'].every((key) => actual[key] === expected[key])
    } catch (error) { diagnosticWarning('read API readiness identity', error, 'INVALID_READINESS_RESPONSE'); return false }
  }
}
export function webIdentityMatches(checkoutId, apiUrl) {
  return (response, body) => {
    try {
      const actual = JSON.parse(body)
      return response.ok && actual.checkoutId === checkoutId && actual.apiUrl === apiUrl
    } catch (error) { diagnosticWarning('read web readiness identity', error, 'INVALID_READINESS_RESPONSE'); return false }
  }
}
import { diagnosticWarning } from './diagnostic-warning.mjs'
