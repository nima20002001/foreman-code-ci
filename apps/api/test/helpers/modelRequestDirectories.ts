export function modelRequestDirectories(
  calls: ReadonlyArray<Record<string, unknown>>,
  workingDirectory: string,
  providerVersion: string,
): string[] {
  return [...new Set(calls.filter(call => call.method === 'model/list' && call.providerVersion === providerVersion)
    .map(call => call.workingDirectory)
    .filter((directory): directory is string => typeof directory === 'string'
      && directory.startsWith(`${workingDirectory}/native-codex-qualification-`)))]
}
