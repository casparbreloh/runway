/**
 * Local dev helper (run via `npm run probe:auth`). Reports whether the operator's
 * bring-your-own credentials are present and working, WITHOUT printing secret values.
 * Optionally packages local auth files into ./.runway-auth/ for manually seeding a sandbox.
 *
 * This is NOT production credential storage and NOT hosted custody — it is a private
 * dev helper that reads files already on your machine.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import process from 'node:process';

type Level = 'ok' | 'partial' | 'missing';

interface Check {
  name: string;
  level: Level;
  reason: string;
}

const MARKER: Record<Level, string> = {
  ok: '[ok]  ',
  partial: '[warn]',
  missing: '[--]  ',
};

/** Run a command quietly; return true on exit 0. Never throws, never prints output. */
function commandSucceeds(command: string): boolean {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Non-reversible hint: presence + length only, never the value. */
function presenceHint(value: string): string {
  return `set (len ${value.length})`;
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function checkCodex(): Check {
  const name = 'Codex';
  const cliFound = commandSucceeds('codex --version');
  const authPath = join(codexHome(), 'auth.json');
  let hasBackendTokens = false;
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, 'utf8'));
      hasBackendTokens = parsed != null && typeof parsed === 'object' && 'tokens' in parsed;
    } catch {
      hasBackendTokens = false;
    }
  }
  const cli = cliFound ? 'cli found' : 'cli not on PATH';
  if (hasBackendTokens) return { name, level: 'ok', reason: `${cli}; auth.json has backend tokens` };
  if (process.env.OPENAI_API_KEY)
    return { name, level: 'partial', reason: `${cli}; api key won't authenticate codex cloud (no backend tokens)` };
  return { name, level: 'missing', reason: `${cli}; no auth.json tokens and no OPENAI_API_KEY` };
}

function checkPi(): Check {
  const name = 'Pi';
  const cliFound = commandSucceeds('pi --version');
  const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json');
  const hasSettings = existsSync(settingsPath);
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  const cli = cliFound ? 'cli found' : 'cli not on PATH';
  if (hasKey || hasSettings) {
    const via = hasKey ? 'api key set' : 'settings.json present';
    return { name, level: 'ok', reason: `${cli}; ${via}` };
  }
  return { name, level: 'missing', reason: `${cli}; no api key and no ~/.pi/agent/settings.json` };
}

function checkGitHub(): Check {
  const name = 'GitHub';
  if (process.env.GITHUB_TOKEN)
    return { name, level: 'ok', reason: `GITHUB_TOKEN ${presenceHint(process.env.GITHUB_TOKEN)}` };
  if (commandSucceeds('gh auth status')) return { name, level: 'ok', reason: 'gh auth status ok' };
  return { name, level: 'missing', reason: 'no GITHUB_TOKEN and gh not authenticated' };
}

function checkLinear(): Check {
  const name = 'Linear';
  const apiKeyNote = process.env.LINEAR_API_KEY ? '; LINEAR_API_KEY also set' : '; LINEAR_API_KEY optional, not set';
  if (process.env.LINEAR_WEBHOOK_SECRET)
    return {
      name,
      level: 'ok',
      reason: `LINEAR_WEBHOOK_SECRET ${presenceHint(process.env.LINEAR_WEBHOOK_SECRET)}${apiKeyNote}`,
    };
  return { name, level: 'missing', reason: `no LINEAR_WEBHOOK_SECRET${apiKeyNote}` };
}

function checkCloudflare(): Check {
  const name = 'Cloudflare';
  if (process.env.CLOUDFLARE_API_TOKEN)
    return { name, level: 'ok', reason: `CLOUDFLARE_API_TOKEN ${presenceHint(process.env.CLOUDFLARE_API_TOKEN)}` };
  if (commandSucceeds('npx --no-install wrangler whoami')) return { name, level: 'ok', reason: 'wrangler whoami ok' };
  return { name, level: 'missing', reason: 'no CLOUDFLARE_API_TOKEN; run wrangler login' };
}

function runReport(): void {
  const checks = [checkCodex(), checkPi(), checkGitHub(), checkLinear(), checkCloudflare()];
  console.log('Runway auth probe (local dev helper — no secrets are printed)\n');
  for (const c of checks) console.log(`${MARKER[c.level]} ${c.name.padEnd(11)} ${c.reason}`);

  const count = (level: Level) => checks.filter((c) => c.level === level).length;
  console.log(`\nSummary: ${count('ok')} ok, ${count('partial')} partial, ${count('missing')} missing`);
}

/** Copy local auth artifacts into ./.runway-auth/ for manual sandbox seeding. Paths only, never contents. */
function packageAuth(): void {
  const targets = [
    { label: 'codex auth.json', src: join(codexHome(), 'auth.json') },
    { label: 'pi settings.json', src: join(homedir(), '.pi', 'agent', 'settings.json') },
  ];
  const outDir = join(process.cwd(), '.runway-auth');
  mkdirSync(outDir, { recursive: true });

  const bundled: string[] = [];
  for (const { label, src } of targets) {
    if (!existsSync(src)) continue;
    const dest = join(outDir, src.split('/').filter(Boolean).join('__'));
    copyFileSync(src, dest);
    bundled.push(`  ${label}: ${src} -> ${dest}`);
  }

  console.log(`Packaging local auth into ${outDir}\n`);
  if (bundled.length) console.log(bundled.join('\n'));
  else console.log('  (nothing to bundle: no local auth artifacts found)');
  console.log(
    '\nWARNING: .runway-auth/ is a private dev helper for manually seeding a sandbox.' +
      '\nIt is NOT hosted credential custody. Keep it gitignored and never share it.',
  );
}

function printHelp(): void {
  console.log(
    [
      'Usage: npm run probe:auth [--package] [--help]',
      '',
      'Reports presence/health of bring-your-own credentials (Codex, Pi, GitHub, Linear,',
      'Cloudflare) without printing any secret values. Always exits 0 — it is a report.',
      '',
      'Flags:',
      '  --package  Copy existing local auth files (codex auth.json, pi settings.json)',
      '             into ./.runway-auth/ (gitignored) for manual sandbox seeding.',
      '  --help     Show this message.',
    ].join('\n'),
  );
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
  } else if (args.includes('--package')) {
    packageAuth();
  } else {
    runReport();
  }
  process.exit(0);
}

main();
