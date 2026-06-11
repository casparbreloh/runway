import { secretNameOf } from "@runway/core";
import type { Registry, WebhookTimestamp, WebhookTrigger } from "@runway/core";

import { classOf } from "./naming.ts";

const timestampEqual = (a?: WebhookTimestamp, b?: WebhookTimestamp): boolean =>
  a?.source === b?.source && a?.field === b?.field && a?.toleranceMs === b?.toleranceMs;

const verificationDiffs = (
  a: WebhookTrigger<unknown>,
  b: WebhookTrigger<unknown>,
): ReadonlyArray<string> => {
  const render = (value: unknown): string => (value === undefined ? "none" : JSON.stringify(value));
  const diffs: string[] = [];
  if (secretNameOf(a.secret) !== secretNameOf(b.secret)) {
    diffs.push(`secret (${render(secretNameOf(a.secret))} vs ${render(secretNameOf(b.secret))})`);
  }
  if (a.signatureHeader !== b.signatureHeader) {
    diffs.push(`signatureHeader (${render(a.signatureHeader)} vs ${render(b.signatureHeader)})`);
  }
  if (a.prefix !== b.prefix) diffs.push(`prefix (${render(a.prefix)} vs ${render(b.prefix)})`);
  if (!timestampEqual(a.timestamp, b.timestamp)) {
    diffs.push(`timestamp (${render(a.timestamp)} vs ${render(b.timestamp)})`);
  }
  return diffs;
};

export const validateRegistry = (registry: Registry): void => {
  const paths = new Map<string, { path: string; trigger: WebhookTrigger<unknown> }>();
  const classes = new Map<string, string>();
  for (const w of registry) {
    const className = classOf(w.def.id);
    const classOwner = classes.get(className);
    if (classOwner) {
      throw new Error(`${w.path}: generated class name ${className} already used by ${classOwner}`);
    }
    classes.set(className, w.path);
    if (w.def.trigger.type === "webhook") {
      const owner = paths.get(w.def.trigger.path);
      if (!owner) {
        paths.set(w.def.trigger.path, { path: w.path, trigger: w.def.trigger });
        continue;
      }
      const diffs = verificationDiffs(w.def.trigger, owner.trigger);
      if (diffs.length > 0) {
        throw new Error(
          `${w.path}: webhook path ${JSON.stringify(w.def.trigger.path)} conflicts with ${owner.path}: ${diffs.join(", ")}`,
        );
      }
    }
  }
};
