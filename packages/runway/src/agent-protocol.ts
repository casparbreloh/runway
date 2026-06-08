/**
 * Wire contract between the Worker (`runAgent` in step.ts) and the sandbox runner
 * (packages/sandbox/src/runner.ts). Both import this module — single source of
 * truth. The Worker writes a RunnerInput JSON file and reads a RunnerOutput back.
 */
export interface RunnerInput {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
}

export type RunnerOutput = { readonly ok: true } | { readonly ok: false; readonly error: string };
