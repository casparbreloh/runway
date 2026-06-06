import type { JobResult, JobSpec } from '../types';
import type { SandboxRunner } from '../sandbox';

export interface PiOptions {
  githubToken: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Sandbox working directory. Defaults to "/work". */
  workdir?: string;
}

/** Last ~2000 chars of a log, for failure reporting. */
function tail(s: string): string {
  return s.length > 2000 ? s.slice(-2000) : s;
}

/** Strip an embedded clone token (x-access-token:<token>@) so it never reaches logs/state. */
function redact(s: string): string {
  return s.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

/**
 * Run a full pi job inside the sandbox: clone -> plan -> pi -> validate -> commit -> push.
 * Opening the PR is the Worker's job (this function has no network access).
 */
export async function runPi(spec: JobSpec, runner: SandboxRunner, opts: PiOptions): Promise<JobResult> {
  const workdir = opts.workdir ?? '/work';
  const repoDir = `${workdir}/repo`;

  try {
    // Secrets and the (un-sanitizable) commit message travel via the sandbox env, never as literal
    // command text — so they can't be interpolated into a shell string or leaked into recorded logs.
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0',
      GITHUB_TOKEN: opts.githubToken,
      RUNWAY_COMMIT_MSG: spec.title ?? `Runway: ${spec.branch}`,
    };
    if (opts.anthropicApiKey) env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
    if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;
    await runner.setEnvVars(env);

    const clone = await runner.exec(
      `git clone --depth 1 https://x-access-token:\${GITHUB_TOKEN}@github.com/${spec.repo.owner}/${spec.repo.name}.git ${repoDir}`,
    );
    if (!clone.success) {
      return { jobId: spec.id, executor: 'pi', status: 'failure', error: 'git clone failed', logsTail: redact(tail(clone.stderr)) };
    }
    await runner.exec(
      `cd ${repoDir} && git checkout -B ${spec.branch} && git config user.email runway@local && git config user.name Runway`,
    );

    await runner.writeFile(`${repoDir}/PLAN.md`, spec.plan);

    const pi = await runner.exec(
      `cd ${repoDir} && pi -p "Read PLAN.md and implement it. Make the smallest change that satisfies it." --approve`,
    );
    if (!pi.success) {
      return {
        jobId: spec.id,
        executor: 'pi',
        status: 'failure',
        error: 'pi step failed',
        logsTail: redact(tail(pi.stderr)),
      };
    }

    const validateCmds = spec.validate ?? [];
    let validated: boolean | undefined;
    for (const cmd of validateCmds) {
      const v = await runner.exec(`cd ${repoDir} && ${cmd}`);
      validated = (validated ?? true) && v.success;
    }

    await runner.exec(`cd ${repoDir} && git add -A`);
    // `git diff --cached --quiet` exits 0 when nothing is staged, non-zero when there are changes.
    const staged = await runner.exec(`cd ${repoDir} && git diff --cached --quiet`);
    if (staged.success) {
      return {
        jobId: spec.id,
        executor: 'pi',
        status: 'success',
        validated,
        pushed: false,
        summary: 'pi job completed; no changes produced, nothing to push.',
      };
    }

    const commit = await runner.exec(`cd ${repoDir} && git commit -m "$RUNWAY_COMMIT_MSG"`);
    if (!commit.success) {
      return {
        jobId: spec.id,
        executor: 'pi',
        status: 'failure',
        validated,
        error: 'git commit failed',
        logsTail: redact(tail(commit.stderr)),
      };
    }

    const push = await runner.exec(`cd ${repoDir} && git push -u origin ${spec.branch}`);
    if (!push.success) {
      return {
        jobId: spec.id,
        executor: 'pi',
        status: 'failure',
        validated,
        pushed: false,
        error: 'git push failed',
        logsTail: redact(tail(push.stderr)),
      };
    }

    const summary =
      validated === false
        ? `pi job completed; validation failed (${validateCmds.length} command(s)); branch ${spec.branch} pushed.`
        : `pi job completed; branch ${spec.branch} pushed.`;
    return {
      jobId: spec.id,
      executor: 'pi',
      status: 'success',
      validated,
      pushed: true,
      summary,
    };
  } finally {
    await runner.destroy();
  }
}
