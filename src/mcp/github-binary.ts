import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTimeout } from "../utils/timeout.ts";
import { redactGithubSecrets } from "./security.ts";

export const GITHUB_RELEASE_API =
  "https://api.github.com/repos/github/github-mcp-server/releases/latest";
export const GITHUB_MCP_BINARY = "github-mcp-server";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseMetadata {
  tag_name?: string;
  assets?: ReleaseAsset[];
}

export interface GithubReleaseSelection {
  archive: ReleaseAsset;
  checksums: ReleaseAsset;
}

export interface GithubInstallOptions {
  binDirectory?: string;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  architecture?: string;
}

function platformAssetParts(
  platform: NodeJS.Platform,
  architecture: string,
): { osName: string; archName: string } | null {
  const osName = platform === "darwin" ? "Darwin" : platform === "linux" ? "Linux" : null;
  const archName = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x86_64" : null;
  return osName && archName ? { osName, archName } : null;
}

export function selectGithubReleaseAssets(
  metadata: ReleaseMetadata,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): GithubReleaseSelection {
  const parts = platformAssetParts(platform, architecture);
  if (!parts) {
    throw new Error(`Automatic GitHub MCP install is not supported on ${platform} ${architecture}.`);
  }
  if (!Array.isArray(metadata.assets)) throw new Error("GitHub release metadata has no assets.");
  const archivePattern = new RegExp(
    `^github-mcp-server_${parts.osName}_${parts.archName}\\.tar\\.gz$`,
  );
  const archive = metadata.assets.find((asset) => archivePattern.test(asset.name));
  const checksums = metadata.assets.find((asset) => /_checksums\.txt$/.test(asset.name));
  if (!archive || !checksums) {
    throw new Error(`The official GitHub MCP release has no asset for ${platform} ${architecture}.`);
  }
  for (const asset of [archive, checksums]) {
    if (!asset.browser_download_url.startsWith(
      "https://github.com/github/github-mcp-server/releases/download/",
    )) {
      throw new Error("GitHub release metadata contained an unofficial download URL.");
    }
  }
  return { archive, checksums };
}

async function fetchChecked(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "hcode-github-mcp",
    },
  });
  if (!response.ok) throw new Error(`GitHub download failed (HTTP ${response.status}).`);
  return response;
}

export async function runGithubCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<string> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-20_000); });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  return withTimeout((signal) => new Promise<string>((resolve, reject) => {
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve(stdout);
      else reject(new Error(redactGithubSecrets(stderr.trim() || `${command} exited with code ${code}`)));
    });
  }), timeoutMs, command);
}

export async function installGithubMcpServer(
  options: GithubInstallOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const binDirectory = options.binDirectory ?? path.join(os.homedir(), ".hcode", "bin");
  const metadataResponse = await fetchChecked(fetchImpl, GITHUB_RELEASE_API);
  const metadata = await metadataResponse.json() as ReleaseMetadata;
  const selected = selectGithubReleaseAssets(
    metadata,
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
  );
  const [archiveResponse, checksumsResponse] = await Promise.all([
    fetchChecked(fetchImpl, selected.archive.browser_download_url),
    fetchChecked(fetchImpl, selected.checksums.browser_download_url),
  ]);
  const archive = new Uint8Array(await archiveResponse.arrayBuffer());
  const checksums = await checksumsResponse.text();
  const checksumLine = checksums.split(/\r?\n/).find((line) =>
    line.trim().endsWith(selected.archive.name)
  );
  const expected = checksumLine?.trim().split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error("The official GitHub MCP release checksum is missing.");
  }
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("GitHub MCP download failed checksum verification.");
  }

  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(path.join(binDirectory, ".github-mcp-install-"));
  const archivePath = path.join(temporaryDirectory, selected.archive.name);
  const finalPath = path.join(binDirectory, GITHUB_MCP_BINARY);
  try {
    await writeFile(archivePath, archive, { mode: 0o600 });
    const listing = await runGithubCommand("tar", ["-tzf", archivePath]);
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (entries.some((entry) => path.isAbsolute(entry) || entry.split("/").includes(".."))) {
      throw new Error("The GitHub MCP archive contains an unsafe path.");
    }
    const binaryEntry = entries.find((entry) => path.basename(entry) === GITHUB_MCP_BINARY);
    if (!binaryEntry) throw new Error("The GitHub MCP archive does not contain its server binary.");
    await runGithubCommand("tar", ["-xzf", archivePath, "-C", temporaryDirectory, binaryEntry]);
    const extractedPath = path.join(temporaryDirectory, binaryEntry);
    const stagedPath = path.join(binDirectory, `.github-mcp-server-${process.pid}.tmp`);
    await copyFile(extractedPath, stagedPath);
    await chmod(stagedPath, 0o755);
    await rename(stagedPath, finalPath);
    await chmod(finalPath, 0o755);
    return finalPath;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
