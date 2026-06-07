import type { AgentName } from "../domain.ts";

export type Trigger = "linear" | { readonly cron: string };

interface StepBase {
  readonly forEach?: string;
}

export interface RunStep extends StepBase {
  readonly run: string;
  readonly pr?: boolean;
}

export interface ShellStep extends StepBase {
  readonly shell: string;
  readonly as?: string;
}

export interface ReportStep extends StepBase {
  readonly report: true;
}

export type Step = RunStep | ShellStep | ReportStep;

export interface FlowManifest {
  readonly id: string;
  readonly trigger: Trigger;
  readonly repo?: string;
  readonly agent?: AgentName;
  readonly steps: readonly Step[];
}

export const isRun = (step: Step): step is RunStep => "run" in step;
export const isShell = (step: Step): step is ShellStep => "shell" in step;
export const isReport = (step: Step): step is ReportStep => "report" in step;
