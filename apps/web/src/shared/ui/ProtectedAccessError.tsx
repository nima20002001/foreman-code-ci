import { ApiError } from '../api/client'

export function ProtectedAccessError({ error }: { error: ApiError; returnTo?: string }) {
  return <section role="alert" className="access-message">
    <h1>Access unavailable</h1><p>{error.message}</p>
    <p>Refresh this page after checking the local API connection.</p>
  </section>
}
