import type { JobResult, JobSpec } from '../types';
import type { SandboxRunner } from '../sandbox';

export interface CodexCloudOptions {
  /** Codex Cloud environment id to submit the task into. */
  envId: string;
  /** ChatGPT/Codex backend access token for headless login (not a bare API key). */
  accessToken?: string;
}

/** Submit a Codex Cloud task from inside the sandbox and return its task URL/ID. */
export async function runCodexCloud(
  spec: JobSpec,
  runner: SandboxRunner,
  opts: CodexCloudOptions,
): Promise<JobResult> {
  const base: Pick<JobResult, 'jobId' | 'executor'> = { jobId: spec.id, executor: 'codex-cloud' };

  const envId = opts.envId;
  if (!envId) return { ...base, status: 'failure', error: 'missing CODEX_CLOUD_ENV_ID' };

  try {
    if (opts.accessToken) {
      await runner.setEnvVars({ CODEX_ACCESS_TOKEN: opts.accessToken });
      await runner.exec('printenv CODEX_ACCESS_TOKEN | codex login --with-access-token');
    }

    await runner.writeFile('/work/prompt.txt', spec.plan);

    const r = await runner.exec(
      `cat /work/prompt.txt | codex cloud exec --env ${envId} --branch ${spec.branch} -`,
    );

    if (!r.success) {
      return { ...base, status: 'failure', error: 'codex cloud exec failed', logsTail: r.stderr.slice(-2000) };
    }

    const taskUrl = r.stdout.trim().split('\n').filter((l) => l.trim()).pop() ?? '';
    if (!taskUrl.startsWith('https://chatgpt.com/codex/tasks/')) {
      return {
        ...base,
        status: 'failure',
        error: 'codex cloud exec produced no task URL',
        logsTail: (r.stdout + r.stderr).slice(-2000),
      };
    }
    const taskId = taskUrl.split('/').pop() ?? '';
    return { ...base, status: 'submitted', taskUrl, taskId, summary: 'Submitted to Codex Cloud' };
  } finally {
    await runner.destroy();
  }
}
