import { describe, expect, it } from 'vitest';
import { runCodexCloud } from '../src/executors/codex-cloud';
import { RecordingRunner } from '../src/sandbox';
import type { JobSpec } from '../src/types';

function makeSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: 'job-1',
    repo: { owner: 'acme', name: 'widget' },
    branch: 'runway/job-1',
    plan: 'Add a hello endpoint.\nReturn 200.',
    executor: 'codex-cloud',
    base: 'main',
    ...overrides,
  };
}

describe('runCodexCloud', () => {
  it('submits a task and parses taskUrl/taskId', async () => {
    const runner = new RecordingRunner(() => ({ stdout: 'https://chatgpt.com/codex/tasks/abc123\n' }));

    const result = await runCodexCloud(makeSpec(), runner, { envId: 'env-123' });

    expect(runner.commands.some((c) => c.includes('codex cloud exec --env'))).toBe(true);
    expect(result.status).toBe('submitted');
    expect(result.taskUrl).toBe('https://chatgpt.com/codex/tasks/abc123');
    expect(result.taskId).toBe('abc123');
    expect(runner.destroyed).toBe(true);
  });

  it('returns failure when envId is missing', async () => {
    const runner = new RecordingRunner(() => ({ stdout: 'https://chatgpt.com/codex/tasks/abc123\n' }));

    const result = await runCodexCloud(makeSpec(), runner, { envId: '' });

    expect(result.status).toBe('failure');
    expect(result.error).toBe('missing CODEX_CLOUD_ENV_ID');
  });

  it('logs in headlessly when an access token is provided', async () => {
    const runner = new RecordingRunner(() => ({ stdout: 'https://chatgpt.com/codex/tasks/abc123\n' }));

    await runCodexCloud(makeSpec(), runner, { envId: 'env-123', accessToken: 'tok-secret' });

    expect(runner.commands.some((c) => c.includes('codex login --with-access-token'))).toBe(true);
    expect(runner.envVars.CODEX_ACCESS_TOKEN).toBe('tok-secret');
  });

  it('destroys the runner and reports failure when exec fails', async () => {
    const runner = new RecordingRunner(() => ({ exitCode: 1, stderr: 'boom' }));

    const result = await runCodexCloud(makeSpec(), runner, { envId: 'env-123' });

    expect(result.status).toBe('failure');
    expect(result.error).toBe('codex cloud exec failed');
    expect(result.logsTail).toBe('boom');
    expect(runner.destroyed).toBe(true);
  });

  it('reports failure (not a phantom submit) when exec exits 0 but prints no task URL', async () => {
    const runner = new RecordingRunner(() => ({ stdout: '' }));

    const result = await runCodexCloud(makeSpec(), runner, { envId: 'env-123' });

    expect(result.status).toBe('failure');
    expect(result.error).toMatch(/no task URL/i);
    expect(result.taskUrl).toBeUndefined();
    expect(runner.destroyed).toBe(true);
  });
});
