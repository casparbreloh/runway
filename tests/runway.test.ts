import { bindingName, createRouter, toEntrypoint, webhook, workflow } from "runway";
import { describe, expect, it } from "vitest";

import linearToPr from "../workflows/linear-to-pr.ts";

// Verifies the SDK wiring end-to-end without deploying: the router actually routes, verifies,
// and creates a workflow instance through a fake binding.

const fakeEnv = (onCreate: (params: unknown) => void): Env => {
  const wf = {
    create: async (opts: { params?: unknown }) => {
      onCreate(opts.params);
      return { id: "instance-1" };
    },
  };
  return { T: wf, LINEAR_TO_PR: wf } as unknown as Env;
};

const tWorkflow = workflow<{ a: string }>({
  name: "t",
  trigger: webhook<{ a: string }>({ path: "/hooks/t" }),
  run: async () => {},
});

describe("runway sdk", () => {
  it("maps a workflow name to its UPPER_SNAKE binding", () => {
    expect(bindingName("linear-to-pr")).toBe("LINEAR_TO_PR");
  });

  it("compiles the example workflow to a WorkflowEntrypoint subclass", () => {
    expect(typeof toEntrypoint(linearToPr)).toBe("function");
  });

  it("creates a workflow instance from a matching webhook (202)", async () => {
    const seen: unknown[] = [];
    const app = createRouter([tWorkflow]);
    const res = await app.fetch(
      new Request("https://x/hooks/t", { method: "POST", body: JSON.stringify({ a: "ok" }) }),
      fakeEnv((p) => seen.push(p)),
    );
    expect(res.status).toBe(202);
    expect(seen).toEqual([{ a: "ok" }]);
  });

  it("404s an unmatched path and 400s invalid json", async () => {
    const app = createRouter([tWorkflow]);
    const env = fakeEnv(() => {});

    const miss = await app.fetch(new Request("https://x/nope", { method: "POST" }), env);
    expect(miss.status).toBe(404);

    const bad = await app.fetch(
      new Request("https://x/hooks/t", { method: "POST", body: "{not json" }),
      env,
    );
    expect(bad.status).toBe(400);
  });
});
