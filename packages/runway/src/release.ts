import { shell } from "./internal/tool.ts";
import { defineToolProvider, type ToolProvider } from "./tools.ts";

export interface ReleaseOptions {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly executable: string;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const release = (options: ReleaseOptions): ToolProvider => {
  if (!NAME.test(options.name))
    throw new Error(`invalid release name ${JSON.stringify(options.name)}`);
  if (!options.version || !SHA256.test(options.sha256) || !options.executable) {
    throw new Error(`invalid release provider ${options.name}`);
  }
  const root = `/cache/runway/tools/release/${options.name}`;
  const staging = `/tmp/runway-release-${options.name}`;
  const archive = `${staging}/release.tar.gz`;
  const executable = options.executable.replace(/^\.\//, "");
  if (executable.startsWith("/") || executable.split("/").includes("..")) {
    throw new Error(`invalid release executable ${JSON.stringify(options.executable)}`);
  }
  return defineToolProvider({
    id: `release-${options.name}`,
    cache: {
      paths: [root],
      key: `runway-release-${options.name}-${options.version}-${options.sha256}-${executable}`,
    },
    setup: [
      `mkdir -p ${shell(`${root}/bin`)}`,
      `if [ ! -x ${shell(`${root}/bin/${options.name}`)} ]; then rm -rf ${shell(staging)}; mkdir -p ${shell(staging)}; curl --fail --location --retry 3 ${shell(options.url)} -o ${shell(archive)}; echo ${shell(`${options.sha256}  ${archive}`)} | sha256sum --check -; tar -xzf ${shell(archive)} -C ${shell(staging)}; cp ${shell(`${staging}/${executable}`)} ${shell(`${root}/bin/${options.name}`)}; chmod +x ${shell(`${root}/bin/${options.name}`)}; rm -rf ${shell(staging)}; fi`,
    ].join("\n"),
    paths: [`${root}/bin`],
  });
};
