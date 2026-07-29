import {
  constants,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const ICLOUD_PATH_FRAGMENT = `${sep}Library${sep}Mobile Documents${sep}`;
const CLOUD_STORAGE_PATH_FRAGMENT =
  `${sep}Library${sep}CloudStorage${sep}`;
const COMMON_SYNC_DIRECTORY_NAMES = new Set([
  "Box",
  "Dropbox",
  "Google Drive",
  "iCloud Drive",
  "OneDrive",
]);

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface PreparedOutputIdentity {
  readonly root: FileIdentity;
  readonly output: FileIdentity;
  readonly rootPath: string;
  readonly outputPath: string;
}

const preparedOutputIdentities =
  new WeakMap<PrivateOutputDirectory, PreparedOutputIdentity>();

export interface PrivateOutputDirectory {
  readonly rootDirectory: string;
  readonly path: string;
  readonly relativePath: string;
  readonly workspaceDirectory: string;
}

interface ResolvePrivateOutputOptions {
  privateDataDirectory: string;
  requestedDirectory: string;
  workspaceDirectory?: string;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child === "" ||
    (child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child))
  );
}

function isStrictChild(parent: string, candidate: string): boolean {
  return parent !== candidate && isInsideOrEqual(parent, candidate);
}

function isICloudPath(path: string): boolean {
  return normalize(path).includes(ICLOUD_PATH_FRAGMENT);
}

function hasPathSegment(path: string, segment: string): boolean {
  return resolve(path).split(sep).includes(segment);
}

function isSyncedOrNetworkPath(path: string): boolean {
  const normalized = normalize(resolve(path));
  const volumeRoot = `${sep}Volumes`;
  return (
    isICloudPath(normalized) ||
    normalized.includes(CLOUD_STORAGE_PATH_FRAGMENT) ||
    normalized === volumeRoot ||
    normalized.startsWith(`${volumeRoot}${sep}`) ||
    [...COMMON_SYNC_DIRECTORY_NAMES].some((directory) =>
      hasPathSegment(normalized, directory),
    )
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let existing = resolve(path);
  const missingSegments: string[] = [];

  while (!(await exists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }

  const canonicalExisting = await realpath(existing);
  return resolve(canonicalExisting, ...missingSegments);
}

async function findGitRoot(startDirectory: string): Promise<string | undefined> {
  let current = resolve(startDirectory);
  const filesystemRoot = parse(current).root;

  while (true) {
    if (await exists(join(current, ".git"))) {
      return realpath(current);
    }
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
}

function assertExternalPrivateRoot(
  privateRoot: string,
  workspaceRoot: string,
): void {
  if (
    isInsideOrEqual(workspaceRoot, privateRoot) ||
    isInsideOrEqual(privateRoot, workspaceRoot)
  ) {
    throw new Error(
      "RESEARCH_PRIVATE_DATA_DIRECTORY must not overlap the Git workspace",
    );
  }
  if (isICloudPath(privateRoot)) {
    throw new Error(
      "RESEARCH_PRIVATE_DATA_DIRECTORY must be outside iCloud storage",
    );
  }
  if (isSyncedOrNetworkPath(privateRoot)) {
    throw new Error(
      "RESEARCH_PRIVATE_DATA_DIRECTORY must be outside synced or network storage",
    );
  }
}

function identityOf(
  value: { readonly dev: bigint; readonly ino: bigint },
): FileIdentity {
  return { device: value.dev, inode: value.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function inspectDirectory(
  path: string,
  label: string,
): Promise<{
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly actualPath: string;
}> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error(
        `${label} must identify a real directory, not a symbolic link`,
      );
    }
    throw error;
  }

  try {
    const [handleStatus, pathStatus, actualPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (!handleStatus.isDirectory() || !pathStatus.isDirectory()) {
      throw new Error(`${label} must identify a directory`);
    }
    if (pathStatus.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link`);
    }
    const handleIdentity = identityOf(handleStatus);
    if (!sameIdentity(handleIdentity, identityOf(pathStatus))) {
      throw new Error(`${label} changed while it was being validated`);
    }
    return {
      handle,
      identity: handleIdentity,
      actualPath,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function inspectAndValidateOutput(
  output: PrivateOutputDirectory,
): Promise<{
  readonly rootHandle: FileHandle;
  readonly outputHandle: FileHandle;
  readonly rootIdentity: FileIdentity;
  readonly outputIdentity: FileIdentity;
  readonly rootPath: string;
  readonly outputPath: string;
}> {
  const root = await inspectDirectory(
    output.rootDirectory,
    "Private-data root",
  );
  let run;
  try {
    run = await inspectDirectory(
      output.path,
      "Private output directory",
    );
  } catch (error) {
    await root.handle.close();
    throw error;
  }

  try {
    const configuredRelativePath = relative(
      output.rootDirectory,
      output.path,
    );
    if (
      configuredRelativePath !== output.relativePath ||
      relative(root.actualPath, run.actualPath) !== output.relativePath ||
      !isStrictChild(root.actualPath, run.actualPath)
    ) {
      throw new Error(
        "Private output directory resolves outside its configured boundary",
      );
    }
    assertExternalPrivateRoot(root.actualPath, output.workspaceDirectory);
    if (
      isInsideOrEqual(output.workspaceDirectory, run.actualPath) ||
      isInsideOrEqual(run.actualPath, output.workspaceDirectory)
    ) {
      throw new Error("Private output directory overlaps the Git workspace");
    }
    if (isSyncedOrNetworkPath(run.actualPath)) {
      throw new Error(
        "Private output directory must be outside synced or network storage",
      );
    }
    if (await findGitRoot(root.actualPath)) {
      throw new Error(
        "RESEARCH_PRIVATE_DATA_DIRECTORY must not be inside any Git repository",
      );
    }
    if (await findGitRoot(run.actualPath)) {
      throw new Error(
        "Private output directory is inside a Git repository",
      );
    }
    return {
      rootHandle: root.handle,
      outputHandle: run.handle,
      rootIdentity: root.identity,
      outputIdentity: run.identity,
      rootPath: root.actualPath,
      outputPath: run.actualPath,
    };
  } catch (error) {
    await Promise.allSettled([root.handle.close(), run.handle.close()]);
    throw error;
  }
}

export async function resolvePrivateOutputDirectory(
  options: ResolvePrivateOutputOptions,
): Promise<PrivateOutputDirectory> {
  if (!isAbsolute(options.privateDataDirectory)) {
    throw new Error(
      "RESEARCH_PRIVATE_DATA_DIRECTORY must be an absolute path",
    );
  }

  const workspaceStart = await realpath(
    resolve(options.workspaceDirectory ?? process.cwd()),
  );
  const workspaceRoot =
    (await findGitRoot(workspaceStart)) ?? workspaceStart;
  const configuredRoot = resolve(options.privateDataDirectory);
  const canonicalRootCandidate =
    await canonicalizePotentialPath(configuredRoot);

  assertExternalPrivateRoot(canonicalRootCandidate, workspaceRoot);
  if (await findGitRoot(canonicalRootCandidate)) {
    throw new Error(
      "RESEARCH_PRIVATE_DATA_DIRECTORY must not be inside any Git repository",
    );
  }

  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const privateRoot = await realpath(configuredRoot);
  assertExternalPrivateRoot(privateRoot, workspaceRoot);
  if (await findGitRoot(privateRoot)) {
    throw new Error(
      "RESEARCH_PRIVATE_DATA_DIRECTORY must not be inside any Git repository",
    );
  }
  const rootInspection = await inspectDirectory(
    privateRoot,
    "Private-data root",
  );
  try {
    await rootInspection.handle.chmod(0o700);
  } finally {
    await rootInspection.handle.close();
  }

  const requested = options.requestedDirectory.trim();
  if (!requested || isAbsolute(requested)) {
    throw new Error(
      "--output must be a relative child directory of RESEARCH_PRIVATE_DATA_DIRECTORY",
    );
  }

  const output = resolve(privateRoot, requested);
  if (!isStrictChild(privateRoot, output)) {
    throw new Error(
      "--output must stay inside RESEARCH_PRIVATE_DATA_DIRECTORY",
    );
  }

  const canonicalOutputCandidate = await canonicalizePotentialPath(output);
  if (!isStrictChild(privateRoot, canonicalOutputCandidate)) {
    throw new Error(
      "--output resolves outside RESEARCH_PRIVATE_DATA_DIRECTORY",
    );
  }
  if (
    isInsideOrEqual(workspaceRoot, canonicalOutputCandidate) ||
    isInsideOrEqual(canonicalOutputCandidate, workspaceRoot)
  ) {
    throw new Error("--output must not overlap the Git workspace");
  }
  if (await findGitRoot(canonicalOutputCandidate)) {
    throw new Error("--output must not be inside any Git repository");
  }

  return {
    rootDirectory: privateRoot,
    path: output,
    relativePath: relative(privateRoot, output),
    workspaceDirectory: workspaceRoot,
  };
}

export async function preparePrivateOutputDirectory(
  output: PrivateOutputDirectory,
): Promise<void> {
  await mkdir(output.path, { recursive: true, mode: 0o700 });
  const inspection = await inspectAndValidateOutput(output);
  try {
    await inspection.rootHandle.chmod(0o700);
    await inspection.outputHandle.chmod(0o700);
    preparedOutputIdentities.set(output, {
      root: inspection.rootIdentity,
      output: inspection.outputIdentity,
      rootPath: inspection.rootPath,
      outputPath: inspection.outputPath,
    });
  } finally {
    await Promise.allSettled([
      inspection.rootHandle.close(),
      inspection.outputHandle.close(),
    ]);
  }
}

export async function revalidatePrivateOutputDirectory(
  output: PrivateOutputDirectory,
): Promise<void> {
  const expected = preparedOutputIdentities.get(output);
  if (!expected) {
    throw new Error(
      "Private output directory must be prepared before files are created",
    );
  }
  const inspection = await inspectAndValidateOutput(output);
  try {
    if (
      !sameIdentity(expected.root, inspection.rootIdentity) ||
      !sameIdentity(expected.output, inspection.outputIdentity) ||
      expected.rootPath !== inspection.rootPath ||
      expected.outputPath !== inspection.outputPath
    ) {
      throw new Error(
        "Private output directory identity changed after preparation",
      );
    }
  } finally {
    await Promise.allSettled([
      inspection.rootHandle.close(),
      inspection.outputHandle.close(),
    ]);
  }
}

export function privateOutputFile(
  output: PrivateOutputDirectory,
  relativeFile: string,
): string {
  if (!relativeFile || isAbsolute(relativeFile)) {
    throw new Error("Private output filename must be a relative path");
  }
  const path = resolve(output.path, relativeFile);
  if (!isStrictChild(output.path, path)) {
    throw new Error("Private output filename escapes the run directory");
  }
  if (dirname(path) !== output.path) {
    throw new Error(
      "Private output filename must be a direct child of the run directory",
    );
  }
  return path;
}

export async function openPrivateOutputFile(
  output: PrivateOutputDirectory,
  relativeFile: string,
): Promise<{ readonly handle: FileHandle; readonly path: string }> {
  if (preparedOutputIdentities.has(output)) {
    await revalidatePrivateOutputDirectory(output);
  } else {
    // Keep the low-level writer safe for callers that construct a validated
    // output descriptor directly (for example, isolated artifact tests).
    await preparePrivateOutputDirectory(output);
  }
  const path = privateOutputFile(output, relativeFile);
  const prepared = preparedOutputIdentities.get(output);
  if (!prepared) {
    throw new Error("Private output directory preparation was not retained");
  }
  const expectedPath = resolve(prepared.outputPath, relativeFile);
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    const [handleStatus, pathStatus, actualPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      !handleStatus.isFile() ||
      !pathStatus.isFile() ||
      pathStatus.isSymbolicLink()
    ) {
      throw new Error("Private output path must identify a regular file");
    }
    if (handleStatus.nlink !== 1n) {
      throw new Error("Private output file must not have multiple links");
    }
    if (
      !sameIdentity(identityOf(handleStatus), identityOf(pathStatus)) ||
      actualPath !== expectedPath
    ) {
      throw new Error(
        "Private output file changed while it was being validated",
      );
    }

    // A second directory check closes the parent-directory swap window before
    // sensitive bytes are written to the already-opened, identity-checked file.
    await revalidatePrivateOutputDirectory(output);
    await handle.chmod(0o600);
    return { handle, path };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function unlinkOpenedPrivateOutputFile(
  output: PrivateOutputDirectory,
  path: string,
  handle: FileHandle,
): Promise<void> {
  await revalidatePrivateOutputDirectory(output);
  const prepared = preparedOutputIdentities.get(output);
  if (!prepared) {
    throw new Error("Private output directory preparation was not retained");
  }
  const expectedPath = resolve(prepared.outputPath, basename(path));
  const [handleStatus, pathStatus, actualPath] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
    realpath(path),
  ]);
  if (
    !handleStatus.isFile() ||
    !pathStatus.isFile() ||
    pathStatus.isSymbolicLink() ||
    !sameIdentity(identityOf(handleStatus), identityOf(pathStatus)) ||
    actualPath !== expectedPath
  ) {
    throw new Error("Private output file identity changed before removal");
  }
  await unlink(path);
}

export async function resolvePrivateInputFile(
  privateRoot: string,
  requestedFile: string,
): Promise<string> {
  const requested = requestedFile.trim();
  if (!requested) {
    throw new Error("Private input filename is required");
  }
  const candidate = isAbsolute(requested)
    ? resolve(requested)
    : resolve(privateRoot, requested);
  const actual = await realpath(candidate);
  if (!isStrictChild(privateRoot, actual)) {
    throw new Error(
      "Private input file must stay inside RESEARCH_PRIVATE_DATA_DIRECTORY",
    );
  }
  if (!(await stat(actual)).isFile()) {
    throw new Error("Private input path must identify a regular file");
  }
  return actual;
}
