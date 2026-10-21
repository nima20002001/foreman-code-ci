import { useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { assertSession, sessionGeneration } from '../api/sessionBoundary'
import { Button, Icon } from './nocturne'

export function LoadMore({ label, query, loadAll = false }: {
  label: string
  loadAll?: boolean
  query: {
    hasNextPage: boolean; isFetching: boolean; isFetchNextPageError: boolean
    fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<{ hasNextPage: boolean; isError: boolean }>
  }
}) {
  const lifetime = useRef(0)
  const inFlight = useRef(false)
  useEffect(() => () => { lifetime.current += 1 }, [])
  const remaining = useMutation({
    mutationFn: async () => {
      const currentLifetime = lifetime.current
      const generation = sessionGeneration()
      try {
        do {
          assertSession(generation)
          const result = await query.fetchNextPage({ cancelRefetch: false })
          if (currentLifetime !== lifetime.current) return
          assertSession(generation)
          if (result.isError || !result.hasNextPage) return
        } while (loadAll)
      } finally { inFlight.current = false }
    },
  })
  const fetching = query.isFetching || remaining.isPending
  const failed = query.isFetchNextPageError || remaining.isError
  const compact = loadAll && !fetching && !failed
  if (!query.hasNextPage) return null
  return <div className="resource-load-more">
    {failed ? <p role="alert">Could not load more {label}. Try again.</p> : null}
    <Button variant="ghost" size="sm" disabled={fetching}
      aria-label={compact ? `Show more ${label}` : undefined}
      leading={compact ? <Icon name="plus" size={15} /> : undefined} onClick={() => {
      if (inFlight.current) return
      inFlight.current = true
      remaining.mutate()
    }}>
      {fetching ? 'Loading…' : failed ? `Retry loading ${label}` : compact ? 'Show more' : `Show more ${label}`}
    </Button>
  </div>
}
