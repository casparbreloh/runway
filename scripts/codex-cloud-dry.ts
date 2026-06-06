import { runCodexCloud } from '../src/executors/codex-cloud';
import { RecordingRunner } from '../src/sandbox';
import type { JobSpec } from '../src/types';

const spec: JobSpec = {
  id: 'dry-codex',
  repo: { owner: 'acme', name: 'widget' },
  branch: 'runway/dry-codex',
  plan: 'Add a hello endpoint.\nMake it return 200.',
  executor: 'codex-cloud',
  base: 'main',
};

const runner = new RecordingRunner(() => ({ stdout: 'https://chatgpt.com/codex/tasks/abc123\n' }));

const result = await runCodexCloud(spec, runner, { envId: 'env-123' });

console.log('commands:', runner.commands);
console.log('result:', result);

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('ASSERT FAILED:', msg);
    process.exit(1);
  }
}

assert(runner.commands.some((c) => c.includes('codex cloud exec --env')), 'exec command recorded');
assert(result.taskId === 'abc123', `taskId is abc123 (got ${result.taskId})`);
assert(runner.destroyed === true, 'runner destroyed');

console.log('codex-cloud:dry OK');
