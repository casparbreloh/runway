import type { AgentName } from "./domain.ts";
import type { HttpStep, RunStep, ShellStep, Step, WorkflowManifest } from "./manifest.ts";

// NOTE: there is no per-step `agent` knob — the interpreter resolves the agent once,
// from the trigger or workflow `options.agent`. RunArgs deliberately omits it so the
// type never advertises a capability the runtime ignores.

// A handle to a recorded step. It is NOT a runtime value: `ref(field)` produces the
// `{{ steps.<id>.<field> }}` template the interpreter resolves at execution time.
export interface StepRef {
  readonly id: string;
  readonly ref: (field: string) => string;
}

interface Modifiers {
  readonly id?: string;
  readonly when?: string;
  readonly forEach?: string;
}

export interface RunArgs extends Modifiers {
  readonly prompt: string;
  readonly pr?: boolean;
  readonly branch?: string;
}

export interface ShellArgs extends Modifiers {
  readonly as?: string;
}

export interface HttpArgs extends Modifiers {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: string;
}

// The recorder surface handed to a `workflow(id, (s) => ...)` builder. Every method
// APPENDS a typed Step to the manifest and returns a StepRef for downstream wiring.
export interface Recorder {
  readonly run: (args: RunArgs) => StepRef;
  readonly shell: (cmd: string, opts?: ShellArgs) => StepRef;
  readonly http: (args: HttpArgs) => StepRef;
  // Low-level escape hatch used by step-builder packages (e.g. @runway/git).
  readonly add: (step: Step, id?: string) => StepRef;
}

const optional = <K extends string, V>(key: K, value: V | undefined): Record<K, V> | object =>
  value === undefined ? {} : { [key]: value };

const modifiers = (m: Modifiers): object => ({
  ...optional("when", m.when),
  ...optional("forEach", m.forEach),
});

class RecorderImpl implements Recorder {
  readonly steps: Step[] = [];

  add(step: Step, id?: string): StepRef {
    const stepId = id ?? step.id ?? `step${this.steps.length}`;
    this.steps.push({ ...step, id: stepId });
    return { id: stepId, ref: (field) => `{{ steps.${stepId}.${field} }}` };
  }

  run(args: RunArgs): StepRef {
    const step: RunStep = {
      run: args.prompt,
      ...optional("pr", args.pr),
      ...optional("branch", args.branch),
      ...modifiers(args),
    };
    return this.add(step, args.id);
  }

  shell(cmd: string, opts: ShellArgs = {}): StepRef {
    const step: ShellStep = { shell: cmd, ...modifiers(opts) };
    return this.add(step, opts.id ?? opts.as);
  }

  http(args: HttpArgs): StepRef {
    const step: HttpStep = {
      http: {
        url: args.url,
        ...optional("method", args.method),
        ...optional("headers", args.headers),
        ...optional("json", args.json),
        ...optional("body", args.body),
      },
      ...modifiers(args),
    };
    return this.add(step, args.id);
  }
}

export interface WorkflowOptions {
  readonly repo?: string;
  readonly agent?: AgentName;
}

// Run the builder once to materialize the Schema-shaped Step[] manifest. The same
// `WorkflowManifest` the declarative authors hand-write — just recorded fluently.
export const workflow = (
  id: string,
  build: (s: Recorder) => void,
  options: WorkflowOptions = {},
): WorkflowManifest => {
  const recorder = new RecorderImpl();
  build(recorder);
  return {
    id,
    steps: recorder.steps,
    ...optional("repo", options.repo),
    ...optional("agent", options.agent),
  };
};
