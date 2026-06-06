import type { SourceName } from "../domain.ts";
import { linearSource } from "./linear.ts";
import { markdownSource } from "./markdown.ts";
import type { Source } from "./source.ts";

export const sources: Record<SourceName, Source> = {
  linear: linearSource,
  markdown: markdownSource,
};

export type { Source, SourceConfig } from "./source.ts";
