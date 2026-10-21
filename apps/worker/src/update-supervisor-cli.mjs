import { setTimeout as wait } from 'node:timers/promises';
import { readUpdateRecord, writeUpdateRecord, superviseWorkerUpdate } from './updateSupervisor.mjs';

try {
  const stateDirectory = process.argv[2];
  if (!stateDirectory?.startsWith('/')) throw new Error('Worker state directory is required.');
  const record = await readUpdateRecord(stateDirectory);
  if (record?.status?.state === 'restarting') {
    if (record.restart?.stateDirectory !== stateDirectory) throw new Error('Worker update restart request is unavailable.');
    record.supervisorStarted = record.restart.requestId;
    await writeUpdateRecord(stateDirectory, record);
    // Let the original Worker persist its maintenance acknowledgement before its service stops.
    await wait(1000);
    await superviseWorkerUpdate(record);
  }
} catch (error) {
  process.stderr.write(`${error.message ?? error.code ?? 'worker_update_supervisor_failed'}\n`);
  process.exitCode = 1;
}
