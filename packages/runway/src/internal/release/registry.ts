import { validateTrigger } from "../../trigger.ts";
import type {
  CronTrigger,
  GitHubEventFilter,
  GitHubRepository,
  GitHubTrigger,
} from "../../trigger.ts";
import { parseRepositorySource, type RepositorySource } from "../source/repository.ts";

export type ReleaseRoute =
  | {
      readonly id: string;
      readonly artifactVersion: string;
      readonly type: "webhook";
      readonly path: string;
    }
  | {
      readonly id: string;
      readonly artifactVersion: string;
      readonly type: "cron";
      readonly expression: string;
    }
  | {
      readonly id: string;
      readonly artifactVersion: string;
      readonly type: "github";
      readonly checkName: string;
      readonly events: readonly GitHubEventFilter[];
    };

export interface ReleaseRegistry {
  readonly schema: 1;
  readonly deploymentName: string;
  readonly defaultBranch?: string;
  readonly repository: RepositorySource;
  readonly github?: {
    readonly repository: GitHubRepository;
    readonly installationId: number;
  };
  readonly secretNames: readonly string[];
  readonly routes: readonly ReleaseRoute[];
}

export interface ActiveRelease {
  readonly schema: 1;
  readonly commit: string;
  readonly registryVersion: string;
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const recordOf = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
};

const artifactVersionOf = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid release registry");
  }
  return value;
};

const routeOf = (value: unknown): ReleaseRoute => {
  const route = recordOf(value, "invalid release registry");
  const { id, artifactVersion, type } = route;
  if (typeof id !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error("invalid release registry");
  }
  const version = artifactVersionOf(artifactVersion);
  if (type === "webhook") {
    if (
      !exactKeys(route, ["artifactVersion", "id", "path", "type"]) ||
      typeof route.path !== "string"
    ) {
      throw new Error("invalid release registry");
    }
    if (
      !route.path.startsWith("/") ||
      route.path.includes("//") ||
      route.path === "/runway" ||
      route.path.startsWith("/runway/")
    ) {
      throw new Error("invalid release registry");
    }
    return { id, artifactVersion: version, type, path: route.path };
  }
  if (type === "cron") {
    if (
      !exactKeys(route, ["artifactVersion", "expression", "id", "type"]) ||
      typeof route.expression !== "string"
    ) {
      throw new Error("invalid release registry");
    }
    try {
      validateTrigger({ type: "cron", expression: route.expression } as CronTrigger);
    } catch {
      throw new Error("invalid release registry");
    }
    return { id, artifactVersion: version, type, expression: route.expression };
  }
  if (type === "github") {
    if (
      !exactKeys(route, ["artifactVersion", "checkName", "events", "id", "type"]) ||
      typeof route.checkName !== "string" ||
      !Array.isArray(route.events)
    ) {
      throw new Error("invalid release registry");
    }
    const trigger = {
      type: "github",
      checkName: route.checkName,
      events: route.events,
    } as unknown as GitHubTrigger<unknown>;
    try {
      validateTrigger(trigger);
    } catch {
      throw new Error("invalid release registry");
    }
    return {
      id,
      artifactVersion: version,
      type,
      checkName: route.checkName,
      events: trigger.events,
    };
  }
  throw new Error("invalid release registry");
};

const githubOf = (value: unknown): NonNullable<ReleaseRegistry["github"]> => {
  const github = recordOf(value, "invalid release registry");
  if (!exactKeys(github, ["installationId", "repository"])) {
    throw new Error("invalid release registry");
  }
  const repository = recordOf(github.repository, "invalid release registry");
  if (
    !exactKeys(repository, ["fullName", "id", "name"]) ||
    typeof repository.id !== "number" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.name !== "string" ||
    repository.name.length === 0 ||
    typeof repository.fullName !== "string" ||
    repository.fullName.length === 0 ||
    typeof github.installationId !== "number" ||
    !Number.isSafeInteger(github.installationId) ||
    github.installationId <= 0
  ) {
    throw new Error("invalid release registry");
  }
  return {
    repository: {
      id: repository.id,
      name: repository.name,
      fullName: repository.fullName,
    },
    installationId: github.installationId,
  };
};

export const encodeReleaseRegistry = (registry: ReleaseRegistry): Uint8Array => {
  const normalized: ReleaseRegistry = {
    schema: 1,
    deploymentName: registry.deploymentName,
    ...(registry.defaultBranch ? { defaultBranch: registry.defaultBranch } : {}),
    repository: registry.repository,
    ...(registry.github ? { github: registry.github } : {}),
    secretNames: [...registry.secretNames].sort(),
    routes: [...registry.routes].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return new TextEncoder().encode(JSON.stringify(normalized));
};

export const decodeReleaseRegistry = (bytes: ArrayBuffer | Uint8Array): ReleaseRegistry => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid release registry");
  }
  const registry = recordOf(value, "invalid release registry");
  const allowed = [
    "deploymentName",
    ...(registry.defaultBranch === undefined ? [] : ["defaultBranch"]),
    ...(registry.github === undefined ? [] : ["github"]),
    "repository",
    "routes",
    "schema",
    "secretNames",
  ];
  if (
    !exactKeys(registry, allowed) ||
    registry.schema !== 1 ||
    typeof registry.deploymentName !== "string" ||
    registry.deploymentName.length === 0 ||
    (registry.defaultBranch !== undefined &&
      (typeof registry.defaultBranch !== "string" || registry.defaultBranch.length === 0)) ||
    !Array.isArray(registry.secretNames) ||
    registry.secretNames.some((name) => typeof name !== "string" || name.length === 0) ||
    !Array.isArray(registry.routes)
  ) {
    throw new Error("invalid release registry");
  }
  let repository: RepositorySource;
  try {
    repository = parseRepositorySource(registry.repository);
  } catch {
    throw new Error("invalid release registry");
  }
  const secretNames = registry.secretNames as string[];
  const routes = registry.routes.map(routeOf);
  const ids = routes.map(({ id }) => id);
  if (
    new Set(secretNames).size !== secretNames.length ||
    secretNames.some((name, index) => index > 0 && secretNames[index - 1]! >= name) ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && ids[index - 1]! >= id)
  ) {
    throw new Error("invalid release registry");
  }
  const github = registry.github === undefined ? undefined : githubOf(registry.github);
  return {
    schema: 1,
    deploymentName: registry.deploymentName,
    ...(typeof registry.defaultBranch === "string"
      ? { defaultBranch: registry.defaultBranch }
      : {}),
    repository,
    ...(github === undefined ? {} : { github }),
    secretNames,
    routes,
  };
};

export const encodeActiveRelease = (active: ActiveRelease): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(active));

export const decodeActiveRelease = (bytes: ArrayBuffer | Uint8Array): ActiveRelease => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid active release");
  }
  const active = recordOf(value, "invalid active release");
  if (
    !exactKeys(active, ["commit", "registryVersion", "schema"]) ||
    active.schema !== 1 ||
    typeof active.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(active.commit) ||
    typeof active.registryVersion !== "string" ||
    !/^[0-9a-f]{64}$/.test(active.registryVersion)
  ) {
    throw new Error("invalid active release");
  }
  return { schema: 1, commit: active.commit, registryVersion: active.registryVersion };
};

export const activeReleaseKey = (deploymentName: string): string =>
  `releases/${deploymentName}/active.json`;

export const releaseRegistryKey = (deploymentName: string, registryVersion: string): string =>
  `releases/${deploymentName}/registries/${registryVersion}.json`;
