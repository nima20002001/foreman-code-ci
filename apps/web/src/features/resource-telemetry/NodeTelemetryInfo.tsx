import { Alert } from '../../shared/ui/nocturne'
import { ScopedResourceTelemetry, type ScopedResourceTelemetryProps } from './ResourceTelemetryCards'

/**
 * Info-slot content for one Agent node. `selection` must come from real accepted/observed placement facts with a
 * complete authorized selector; without it nothing is requested and nothing is guessed.
 */
export function NodeTelemetryInfo({ selection }: { selection?: ScopedResourceTelemetryProps }) {
  if (selection && (selection.computerSelector || selection.ownedSelector || selection.capturedOwned)) return <ScopedResourceTelemetry {...selection} />
  return <Alert title="Computer and resource use unavailable" tone="neutral">
    No accepted or observed computer is available for this node, so no CPU or RAM is requested or shown.
  </Alert>
}
