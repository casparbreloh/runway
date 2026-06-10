import { expect, test } from "vitest";

import { hmacSha256, webhook } from "../src/trigger.ts";
import { createWorkflow } from "../src/workflow.ts";

const trigger = webhook({
  path: "/hello",
  auth: hmacSha256({ header: "linear-signature", secret: "LINEAR_WEBHOOK_SECRET" }),
});

test("rejects secret names that are not valid bindings", () => {
  expect(() => createWorkflow({ id: "hello", trigger, secrets: ["linear-api-key"] })).toThrow(
    'invalid workflow secret "linear-api-key": must be a valid binding name',
  );
});

test("rejects duplicate secret names", () => {
  expect(() =>
    createWorkflow({ id: "hello", trigger, secrets: ["LINEAR_API_KEY", "LINEAR_API_KEY"] }),
  ).toThrow('duplicate workflow secret "LINEAR_API_KEY"');
});

test("defaults secrets to an empty list", () => {
  const def = createWorkflow({ id: "hello", trigger }).handler(async () => {});
  expect(def.secrets).toEqual([]);
});
