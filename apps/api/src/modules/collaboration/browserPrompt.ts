export function browserSessionPrompt(sessionId: string): string {
  return [
    `Your managed browser session is ${JSON.stringify(sessionId)}.`,
    'If browser tools are enabled, first call browser_session_get with this sessionId to read its control epoch, browserGeneration and owned tabs.',
    'Use actor kind "agent" and those current facts for page actions. Read the session again after control returns from a viewer; do not reuse a stale epoch or select another subject’s tabs.',
  ].join('\n')
}
