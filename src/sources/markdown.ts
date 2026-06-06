import { Effect } from "effect";

import { type AgentName, type JobSpec, parseRepo, type Repo, ValidationError } from "../domain.ts";
import type { Source } from "./source.ts";

interface MarkdownBody {
  readonly plan?: unknown;
  readonly repo?: unknown;
  readonly agent?: unknown;
  readonly branch?: unknown;
  readonly base?: unknown;
  readonly validate?: unknown;
  readonly title?: unknown;
  readonly id?: unknown;
}

const BRANCH = /^[A-Za-z0-9._/-]+$/;

const isAgent = (u: unknown): u is AgentName => u === "codex" || u === "pi";

export const markdownSource: Source = {
  name: "markdown",
  toJobSpec: (input, config) =>
    Effect.gen(function* () {
      const body = (input ?? {}) as MarkdownBody;

      const plan = body.plan;
      if (typeof plan !== "string" || !plan) {
        return yield* Effect.fail(new ValidationError({ reason: "plan is required" }));
      }

      const repoSlug =
        (typeof body.repo === "string" ? body.repo : undefined) ?? config.defaultRepo;
      let repo: Repo;
      try {
        if (!repoSlug) throw new Error("missing repo");
        repo = parseRepo(repoSlug);
      } catch (e) {
        return yield* Effect.fail(new ValidationError({ reason: `invalid repo: ${String(e)}` }));
      }

      const agent = body.agent ?? config.defaultAgent;
      if (!isAgent(agent)) {
        return yield* Effect.fail(
          new ValidationError({ reason: `invalid agent: ${JSON.stringify(agent)}` }),
        );
      }

      const rawId = body.id ?? crypto.randomUUID();
      const id = (
        typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : crypto.randomUUID()
      ).toLowerCase();

      const branch = typeof body.branch === "string" ? body.branch : `runway/${id}`;
      if (!BRANCH.test(branch) || branch.startsWith("-")) {
        return yield* Effect.fail(new ValidationError({ reason: `invalid branch: ${branch}` }));
      }

      const base = typeof body.base === "string" ? body.base : config.defaultBase;

      let validate: readonly string[] | undefined;
      if (body.validate !== undefined) {
        if (!Array.isArray(body.validate) || body.validate.some((v) => typeof v !== "string")) {
          return yield* Effect.fail(
            new ValidationError({ reason: "validate must be an array of strings" }),
          );
        }
        validate = body.validate as readonly string[];
      }

      const title = typeof body.title === "string" ? body.title : undefined;

      const spec: JobSpec = {
        id,
        repo,
        branch,
        plan,
        agent,
        base,
        source: { type: "markdown" },
        ...(validate ? { validate } : {}),
        ...(title ? { title } : {}),
      };
      return spec;
    }),
};
