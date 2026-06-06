// Dry-run harness for runPi: drives a RecordingRunner and asserts the recorded command plan
// without touching the cloud. `src/sandbox.ts` keeps @cloudflare/sandbox as a type-only import,
// so this runs directly under `tsx`.
import { runPi } from '../src/executors/pi';
import { RecordingRunner } from '../src/sandbox';
import type { JobSpec } from '../src/types';

const FAKE_TOKEN = 'ghp_FAKE_TOKEN_VALUE_0123456789';

const spec: JobSpec = {
  id: 'pi-dry-sample',
  repo: { owner: 'acme', name: 'widgets' },
  branch: 'runway/pi-dry-sample',
  plan: 'Add a hello() function that returns "hello".',
  executor: 'pi',
  base: 'main',
  validate: ['npm test'],
  title: 'Runway: pi dry sample',
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('pi:dry assertion failed:', msg);
    process.exit(1);
  }
}

// `git diff --cached --quiet` exits non-zero when there are staged changes; simulate a real diff
// so the harness exercises the commit + push path.
const runner = new RecordingRunner((command) =>
  command.includes('git diff --cached --quiet') ? { exitCode: 1 } : {},
);
const result = await runPi(spec, runner, { githubToken: FAKE_TOKEN, anthropicApiKey: 'sk-fake' });

console.log('--- recorded commands ---');
for (const c of runner.commands) console.log(c);
console.log('--- recorded writes ---');
for (const w of runner.writes) console.log(w.path);
console.log('--- result ---');
console.log(JSON.stringify(result, null, 2));

// Commands appear in the expected order.
const order = ['git clone', 'git checkout -B', 'pi -p', 'npm test', 'git push'];
let i = 0;
for (const needle of order) {
  const found = runner.commands.findIndex((c, idx) => idx >= i && c.includes(needle));
  assert(found >= 0, `expected command containing "${needle}" after index ${i}`);
  i = found;
}
assert(
  runner.commands.some((c) => c.includes('pi -p') && c.includes('--approve')),
  'pi command must include --approve',
);
assert(runner.writes.some((w) => w.path.endsWith('PLAN.md')), 'writes must include a PLAN.md path');
assert(
  runner.commands.every((c) => !c.includes(FAKE_TOKEN)),
  'no literal token value may appear in any recorded command',
);
assert(runner.destroyed === true, 'runner must be destroyed');

console.log('pi:dry OK');
