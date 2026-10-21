import { mock } from 'node:test';
import { mockHostMounts, persistentHostMounts } from './hostMounts.mjs';

// Explicit --import fixture for a packaged CLI unit test, never a worker installation setting.
mockHostMounts(mock, persistentHostMounts);
