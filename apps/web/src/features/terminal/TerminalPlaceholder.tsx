import { useId, useState } from 'react'

import { Button, Card, CardBody, CardHeader } from '../../shared/ui/nocturne'

export interface TerminalPlaceholderProps {
  /** Keep the initial state deterministic for the shell and its tests. */
  defaultExpanded?: boolean
}

/**
 * A deliberately small terminal boundary for the wireframe phase.
 *
 * There is no terminal transport behind this component yet. In particular, it
 * does not render a prompt or accept input that could imply a connected shell.
 */
export function TerminalPlaceholder({
  defaultExpanded = false,
}: TerminalPlaceholderProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const contentId = useId()

  return (
    <section
      className="terminal-placeholder"
      data-testid="terminal-placeholder"
      aria-label="No terminal connected"
    >
      <Card>
        <CardHeader
          eyebrow="Terminal"
          title="No terminal connected"
          action={
            <Button
              size="sm"
              aria-controls={contentId}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          }
        />
        {expanded ? (
          <CardBody>
            <p id={contentId}>
              Connect a runner to open a terminal for this workspace. Terminal
              input is unavailable until then.
            </p>
          </CardBody>
        ) : null}
      </Card>
    </section>
  )
}
