import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolvePrivateInputFile,
  resolvePrivateOutputDirectory,
} from "../src/io/private-data-boundary.js";
import {
  withOutputLock,
  writePrivateJson,
} from "../src/io/private-files.js";

async function temporaryDirectory(
  t: { after: (fn: () => Promise<void>) => void },
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return realpath(directory);
}

test("writes only beneath an external absolute private-data root", async (t) => {
  const temporaryRoot = await temporaryDirectory(
    t,
    "gsd-private-boundary-",
  );
  const privateRoot = join(temporaryRoot, "private-data");
  const output = await resolvePrivateOutputDirectory({
    privateDataDirectory: privateRoot,
    requestedDirectory: "snapshots/attio",
  });

  assert.equal(output.rootDirectory, await realpath(privateRoot));
  assert.equal(output.path, join(output.rootDirectory, "snapshots/attio"));
  assert.equal(output.relativePath, "snapshots/attio");

  await withOutputLock(output, async () => {
    await writePrivateJson(output, "people.json", [{ id: "person-1" }]);
  });

  const rootMode = (await stat(output.rootDirectory)).mode & 0o777;
  const runMode = (await stat(output.path)).mode & 0o777;
  const fileMode =
    (await stat(join(output.path, "people.json"))).mode & 0o777;
  assert.equal(rootMode, 0o700);
  assert.equal(runMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test("rejects output traversal and absolute output overrides", async (t) => {
  const temporaryRoot = await temporaryDirectory(
    t,
    "gsd-private-traversal-",
  );
  const privateRoot = join(temporaryRoot, "private-data");

  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: privateRoot,
      requestedDirectory: "../escaped",
    }),
    /must stay inside RESEARCH_PRIVATE_DATA_DIRECTORY/u,
  );
  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: privateRoot,
      requestedDirectory: join(temporaryRoot, "absolute-output"),
    }),
    /--output must be a relative child directory/u,
  );
});

test("rejects private roots in the workspace, synced storage, or another Git repository", async (t) => {
  const temporaryRoot = await temporaryDirectory(
    t,
    "gsd-private-forbidden-",
  );
  const workspace = join(temporaryRoot, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });

  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: join(workspace, "private-data"),
      requestedDirectory: "snapshots/attio",
      workspaceDirectory: workspace,
    }),
    /must not overlap the Git workspace/u,
  );

  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: temporaryRoot,
      requestedDirectory: "workspace/private-data",
      workspaceDirectory: workspace,
    }),
    /must not overlap the Git workspace/u,
  );

  const iCloudRoot = join(
    temporaryRoot,
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "private-data",
  );
  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: iCloudRoot,
      requestedDirectory: "snapshots/attio",
      workspaceDirectory: workspace,
    }),
    /must be outside iCloud storage/u,
  );

  const cloudStorageRoot = join(
    temporaryRoot,
    "Library",
    "CloudStorage",
    "Dropbox",
    "private-data",
  );
  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: cloudStorageRoot,
      requestedDirectory: "snapshots/attio",
      workspaceDirectory: workspace,
    }),
    /must be outside synced or network storage/u,
  );

  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: "/Volumes/Shared Research/private-data",
      requestedDirectory: "snapshots/attio",
      workspaceDirectory: workspace,
    }),
    /must be outside synced or network storage/u,
  );

  const otherGitRepository = join(temporaryRoot, "other-repository");
  await mkdir(join(otherGitRepository, ".git"), { recursive: true });
  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: join(otherGitRepository, "private-data"),
      requestedDirectory: "snapshots/attio",
      workspaceDirectory: workspace,
    }),
    /must not be inside any Git repository/u,
  );

  const broadPrivateRoot = join(temporaryRoot, "broad-private-root");
  const nestedRepository = join(broadPrivateRoot, "nested-repository");
  await mkdir(join(nestedRepository, ".git"), { recursive: true });
  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: broadPrivateRoot,
      requestedDirectory: "nested-repository/output",
      workspaceDirectory: workspace,
    }),
    /--output must not be inside any Git repository/u,
  );
});

test("revalidates the run directory before every write and never writes through a swapped symlink", async (t) => {
  const temporaryRoot = await temporaryDirectory(
    t,
    "gsd-private-directory-swap-",
  );
  const privateRoot = join(temporaryRoot, "private-data");
  const outside = join(temporaryRoot, "outside");
  const displacedRun = join(temporaryRoot, "displaced-run");
  const secret = "must-not-land-outside";
  await mkdir(outside);
  const output = await resolvePrivateOutputDirectory({
    privateDataDirectory: privateRoot,
    requestedDirectory: "runs/swapped",
  });

  await assert.rejects(
    withOutputLock(output, async () => {
      await rename(output.path, displacedRun);
      await symlink(outside, output.path, "dir");
      await writePrivateJson(output, "secret.json", { secret });
    }),
    /symbolic link|identity changed|configured boundary/u,
  );

  const outsideFile = join(outside, "secret.json");
  await assert.rejects(readFile(outsideFile, "utf8"), {
    code: "ENOENT",
  });
});

test("rechecks Git ancestry before each file creation", async (t) => {
  const temporaryRoot = await temporaryDirectory(
    t,
    "gsd-private-late-git-",
  );
  const output = await resolvePrivateOutputDirectory({
    privateDataDirectory: join(temporaryRoot, "private-data"),
    requestedDirectory: "runs/late-git",
  });

  await assert.rejects(
    withOutputLock(output, async () => {
      await mkdir(join(output.path, ".git"));
      await writePrivateJson(output, "secret.json", { secret: true });
    }),
    /inside a Git repository/u,
  );
});

test("rejects a symlinked output path that escapes the private root", async (t) => {
  const temporaryRoot = await temporaryDirectory(
    t,
    "gsd-private-symlink-",
  );
  const privateRoot = join(temporaryRoot, "private-data");
  await mkdir(privateRoot, { recursive: true });
  await symlink(process.cwd(), join(privateRoot, "workspace-link"), "dir");

  await assert.rejects(
    resolvePrivateOutputDirectory({
      privateDataDirectory: privateRoot,
      requestedDirectory: "workspace-link/raw-output",
    }),
    /--output resolves outside RESEARCH_PRIVATE_DATA_DIRECTORY/u,
  );
});

test("accepts only regular input files beneath the private root", async (t) => {
  const temporaryRoot = await temporaryDirectory(
    t,
    "gsd-private-input-",
  );
  const privateRoot = join(temporaryRoot, "private-data");
  const insideDirectory = join(privateRoot, "directory");
  const outside = join(temporaryRoot, "outside.json");
  await mkdir(insideDirectory, { recursive: true });
  await writeFile(join(privateRoot, "inside.json"), "{}");
  await writeFile(outside, "{}");
  await symlink(outside, join(privateRoot, "outside-link.json"));

  assert.equal(
    await resolvePrivateInputFile(privateRoot, "inside.json"),
    join(privateRoot, "inside.json"),
  );
  await assert.rejects(
    resolvePrivateInputFile(privateRoot, outside),
    /must stay inside RESEARCH_PRIVATE_DATA_DIRECTORY/u,
  );
  await assert.rejects(
    resolvePrivateInputFile(privateRoot, "outside-link.json"),
    /must stay inside RESEARCH_PRIVATE_DATA_DIRECTORY/u,
  );
  await assert.rejects(
    resolvePrivateInputFile(privateRoot, "directory"),
    /regular file/u,
  );
});
