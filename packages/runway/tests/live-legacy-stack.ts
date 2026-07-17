import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { defaultClient } from "../src/cloudflare-api.ts";
import { CloudflareLegacyStackControl } from "../src/cloudflare/legacy-stack.ts";
import { LegacyStack, type LegacyStackReceipt } from "../src/legacy-stack.ts";
import { stackIdOf } from "../src/stack.ts";

const accountId = "7f9a6aa1e42231cfbf32bbd13a9f3910";
const repositoryId = "github:1260842673";

const expected: LegacyStackReceipt = {
  schema: 1,
  authority: "delete-only",
  owner: { accountId, repositoryId, stackId: stackIdOf(accountId, repositoryId) },
  worker: {
    name: "runway-monorepo",
    versionId: "52e21df1-4d95-41e5-9a9a-e3b1ca2f44e2",
    deploymentId: "0090ad4c-c911-412a-ab77-6fa278dac3b0",
    retainedVersionIds: [
      "22a72e29-5246-40fe-be86-d8c95d0ee618",
      "2330fe61-a59a-479a-a58e-5234a12407cc",
      "3d2b1365-638e-4f11-9019-b985057128c8",
      "428aa56f-213e-4884-93fe-6e865bdecdc0",
      "70dc0a36-dcc7-4143-bd52-c6810708d5df",
      "71dff6e9-5aac-469c-8f32-217f1391e167",
      "7328ce84-0b5e-4857-b5ec-2ad7ed841860",
      "7cbe4b7b-caac-4d90-a5ad-73ea3640bc1a",
      "85012b7e-2e03-4951-a4d9-9058d88a4d32",
      "890c2576-ea44-4571-a7fd-3b0b63696a04",
      "9824e201-afc8-4100-9eba-2d5123b50e3d",
      "9e9fe2ee-fe0a-49e8-9519-4d5fbd51a097",
      "a3212a4c-b7e9-4444-923b-a78553279d04",
      "a949096c-f950-4f72-b3b0-e4005a7bc98e",
      "b5115784-a2f0-4ed6-b80c-2db3061ffcfb",
      "b9e338b0-7609-43b1-872f-8a40bdb38e1f",
      "dd7f573a-9674-4aa9-890f-2928086b6105",
      "df77ca1c-6318-4de0-bc7a-bb46c5ba4a6a",
      "e9e5f2a1-fa54-4d2f-a386-bc312e21eb17",
      "f99e04db-6708-4e4c-9d99-7092fb163504",
    ],
    retainedDeploymentIds: [
      "079cfe4e-4284-4a8f-b49f-6e75a46af767",
      "173f0686-ca0c-482f-a1f1-97f2167507a4",
      "1d8c5e82-cb7d-43ee-8cfc-e7c0984ceaed",
      "1e50007c-6097-47c7-8a0b-95cd9ebc0c09",
      "2d0c4980-1431-453a-ab6e-f81f91f0e46a",
      "768624c7-9a8b-480b-8963-9ee7a05c811c",
      "ac95d240-c7de-46cf-95f2-0b5075b35fbd",
      "d15199da-be20-45e1-af89-744f17fb7c96",
      "dd08a881-9e9e-4eaf-8368-865bf2c970d1",
    ],
  },
  workflow: {
    name: "runway-monorepo",
    id: "880fc20a-3879-43a6-b3e3-23caeacc410d",
    className: "DynamicWorkflow",
    scriptName: "runway-monorepo",
    versionId: "731b0a25-7319-4549-b467-552f3c8bffb3",
    retainedVersionIds: [
      "0f8e8314-06e2-4d55-915e-8ab6a232c1d9",
      "26a2c50d-c38a-4134-8a46-aa8b1b0b6e3a",
      "41a93ae9-2bab-43e8-b676-f440ab8b4613",
      "4d68084e-413b-4657-87a2-bc5544f0c389",
      "5660fc25-81ff-47fe-ae99-39c0233658c4",
      "5b872fc0-15fa-4d7d-abbc-08dc86d2a056",
      "6ccbc160-ddd5-4330-972e-3b4c54eb6487",
      "6e8e6da5-2964-48f1-8a9a-1dc93aae6ed1",
      "71c16b29-0a27-4609-884d-b3189129a1b4",
      "73dc8547-7e24-42c6-b689-6190b7f507b5",
      "8b93cc27-bb97-4ed6-963a-0537db8b43af",
      "907b39d0-5d50-4c7c-976b-eb3c46b12980",
      "adabb559-31bf-47f3-82a7-a18ef533f084",
      "be043db2-ffec-4725-bc10-6b5446e5e940",
      "c3eacf2f-c96c-48a0-9682-8fb790bc6efe",
      "c456f7e2-6860-4337-a2df-38886f46ae8a",
      "c5460f85-9fe8-4461-bbd0-f66a19e0fef3",
      "d45f2ab9-10dc-4977-b8e0-c6bcca54fbf7",
      "dab71e14-867c-479e-b709-8032230cb899",
      "e3009eec-b5a1-4889-b820-22bca3ccdb81",
    ],
  },
  container: {
    name: "runway-monorepo-Sandbox",
    id: "a0317930-0174-43f0-bf0d-371928b37385",
    rolloutId: "ff47c4bd-9d96-4603-b904-a0ad316ec3a8",
    imageTag: "docker.io/cloudflare/sandbox:0.12.3",
    resolvedImageDigest: "sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042",
    platform: { os: "linux", architecture: "amd64" },
    version: 3,
    schedulingPolicy: "default",
    maxInstances: 20,
    rolloutActiveGracePeriod: 0,
    tiers: ["1", "2"],
    namespaceId: "c4e5604a095b43ca8c43e1f25bfcf287",
    configuration: {
      vcpu: 0.5,
      memoryMiB: 4096,
      diskSizeMb: 8000,
      runtime: "firecracker",
      networkMode: "private",
      assignIpv4: "none",
      assignIpv6: "none",
      bandwidthLimitMbps: 500,
      command: [],
      entrypoint: [],
    },
    rollouts: [
      {
        id: "f0fe12c1-fb87-4b2c-ae91-dc89d57f45f9",
        status: "replaced",
        currentVersion: 1,
        targetVersion: 2,
      },
      {
        id: "ff47c4bd-9d96-4603-b904-a0ad316ec3a8",
        status: "completed",
        currentVersion: 2,
        targetVersion: 3,
      },
    ],
  },
  namespaces: [
    {
      binding: "RUNWAY_GITHUB_COORDINATOR",
      name: "runway-monorepo_RunwayGitHubCoordinator",
      className: "RunwayGitHubCoordinator",
      id: "8b7d753e43494fc4af09b29d067872b5",
      scriptName: "runway-monorepo",
    },
    {
      binding: "RunwaySandbox",
      name: "runway-monorepo_Sandbox",
      className: "Sandbox",
      id: "c4e5604a095b43ca8c43e1f25bfcf287",
      scriptName: "runway-monorepo",
    },
  ],
  bindings: [
    { name: "LOADER", type: "worker_loader" },
    {
      name: "RUNWAY_ARTIFACTS",
      type: "r2_bucket",
      target: "runway-7f9a6aa1e42231cfbf32bbd13a9f3910",
    },
    {
      name: "RUNWAY_GITHUB_COORDINATOR",
      type: "durable_object_namespace",
      target: "RunwayGitHubCoordinator",
    },
    { name: "RunwaySandbox", type: "durable_object_namespace", target: "Sandbox" },
    { name: "WORKFLOWS", type: "workflow", target: "runway-monorepo" },
  ],
  secretNames: [
    "RUNWAY_GITHUB_APP_ID",
    "RUNWAY_GITHUB_PRIVATE_KEY",
    "RUNWAY_GITHUB_WEBHOOK_SECRET",
    "RUNWAY_SECRET_SNAPSHOT_KEY",
    "RUNWAY_SECRET_SNAPSHOT_KEY_4583caa3b8b643ec9cbeb7ecd768817d",
  ],
  schedules: [],
  workersDev: { enabled: true, previewsEnabled: true },
  routes: [],
  secretSnapshot: {
    binding: "RUNWAY_SECRET_SNAPSHOT_KEY",
    ownedKeyBindings: ["RUNWAY_SECRET_SNAPSHOT_KEY_4583caa3b8b643ec9cbeb7ecd768817d"],
    status: "runway-prefix-current-target-unverifiable",
    disposition: "prune-after-successful-replacement",
  },
  buckets: [
    {
      name: "runway-7f9a6aa1e42231cfbf32bbd13a9f3910",
      authority: "preserve-only",
      objectCount: 46,
      location: "EEUR",
      storageClass: "Standard",
      jurisdiction: "default",
      lifecycle: "default-multipart-abort-7-days",
      publicAccess: false,
      managedDomain: "pub-7fbd9a80677a4a97af819168c28b425d.r2.dev",
      customDomains: [],
      cors: false,
    },
    {
      name: "runway-cache-7f9a6aa1e42231cfbf32bbd13a9f3910",
      authority: "delete-after-replacement",
      objects: [
        {
          key: "caches/1a38d59ea4107e010fd8b6a2ae5262668b0606d9196218e9addbf54d5fed5de9.tar.gz",
          size: 33554432,
          etag: "a39bd53aa59400bf3068c4a1ef189ea4",
        },
        {
          key: "caches/23968e28076c056b779a8e8c907e571e104f0a9404f236f4a2828cc15889b113.tar.gz",
          size: 33554432,
          etag: "1f30f48f12d236861308a6069137a02f",
        },
        {
          key: "caches/304ec1ed951ec190621d2187f7077b60a2fc16390cc679f5e85155a8e9087bd8.tar.gz",
          size: 73400320,
          etag: "2027451a01ca9f847682f0db354e2b20",
        },
        {
          key: "caches/444aa69bb14ffb6659fdceed3d343cd7521ffafec067248286539d03bec2a08d.tar.gz",
          size: 73400320,
          etag: "37bec9765b42ca0a968a2933a1eb31da",
        },
        {
          key: "caches/531d4f7f3d33a58e408aab8a3d9c8a28439b6305235cac956e0bf726e4c4ec15.tar.gz",
          size: 13716319,
          etag: "e948a3d4dce4a78b3b5f0d86c17b4774",
        },
        {
          key: "caches/6144ee12406861fb15c2b253ad9ad6d6eca41e53252cf60c87b93ccf1f8794cf.tar.gz",
          size: 73400320,
          etag: "063ef29ecf89d051ebc25caa7909216a",
        },
        {
          key: "caches/6e61fc8ed834dcf35eef90eb8637e5298be49d825fca11076ec5353698b84910.tar.gz",
          size: 33554432,
          etag: "2a789e005f158107703ccfd0bbf91d33",
        },
        {
          key: "caches/8b15947729ce7ba33b306eefce8ce99d4159c0825ecbd3cdd7bf3d481da0c3e1.tar.gz",
          size: 33554432,
          etag: "db4543911f9d494aa37f5a9ecfb93f0b",
        },
        {
          key: "caches/935f72550fb8312d795f3f65bb04a74f0a4b9c253a7c4b0f27c1723206b183c1.tar.gz",
          size: 33554432,
          etag: "a2757fbfddbbfa885e44ace00a2aae85",
        },
        {
          key: "caches/cc38aa82ceb7604ec9e9a638a5900f70dddb9b9ef3ef6fbd019b37a2063d4500.tar.gz",
          size: 33554432,
          etag: "2e02746108a2c87efd0212aeed5e5655",
        },
        {
          key: "caches/d523dd9620294ecf3b8822e57fec26c0b79b16d86b509f9f3c3c2d76fe5b8d95.tar.gz",
          size: 44081844,
          etag: "f8bd44ab7936aef469d8850888650eec",
        },
      ],
      location: "EEUR",
      storageClass: "Standard",
      jurisdiction: "default",
      lifecycle: "default-multipart-abort-7-days",
      publicAccess: true,
      managedDomain: "pub-13f36f9056c9471c9141c9b25d2c6069.r2.dev",
      customDomains: [],
      cors: false,
    },
  ],
};

const tokenOf = async (): Promise<string> => {
  const { stdout } = await promisify(execFile)("wrangler", ["auth", "token", "--json"], {
    timeout: 10_000,
  });
  const value = JSON.parse(stdout) as { token?: unknown };
  if (typeof value.token !== "string") throw new Error("Wrangler did not return an OAuth token");
  return value.token;
};

const mode = process.argv[2];
if (mode !== "--dry-run" && mode !== "--capture") {
  throw new Error("usage: node packages/runway/tests/live-legacy-stack.ts --dry-run|--capture");
}
const control = new CloudflareLegacyStackControl({
  cf: defaultClient(await tokenOf()),
  accountId,
  expected,
  stateBucket: `runway-state-${accountId}`,
});
const stack = new LegacyStack(expected, control);
const receipt = mode === "--dry-run" ? await stack.check() : await stack.capture();
console.log(JSON.stringify({ mode, stackId: receipt.owner.stackId, authority: receipt.authority }));
