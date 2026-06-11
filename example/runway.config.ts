import { cloudflare } from "@runway/cloudflare";
import { defineConfig } from "@runway/core";

export default defineConfig({ backend: cloudflare() });
