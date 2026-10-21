export interface IntegrationStartupPhase { phase: string; elapsedMs: number; [key: string]: unknown }
export function recordIntegrationStartup(phase: string, details?: Record<string, unknown>,
  environment?: NodeJS.ProcessEnv): void
export function readIntegrationStartup(output: string): IntegrationStartupPhase[]
