import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { discoverProjectFiles } from "../context/ignore.ts";
import type { ToolInteraction } from "./files.ts";
import { searchCode } from "./search.ts";

const TEST_PATTERN = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;

function sourceStem(filePath: string): string {
  return path.basename(filePath).replace(/\.(?:test|spec)(?=\.)/i, "").replace(/\.[^.]+$/, "");
}

function scoreTest(sourcePath: string, candidate: string, mentionsSource: boolean): number {
  const source = sourcePath.replaceAll("\\", "/");
  const sourceDirectory = path.posix.dirname(source);
  const stem = sourceStem(source);
  const candidateStem = sourceStem(candidate);
  let score = 0;
  if (candidateStem === stem) score += 100;
  if (path.posix.dirname(candidate) === sourceDirectory) score += 40;
  if (candidate.includes("/__tests__/")) score += 25;
  if (candidate.startsWith("tests/") || candidate.startsWith("test/")) score += 15;
  if (mentionsSource) score += 60;
  return score;
}

export async function findTests(
  projectRoot: string,
  sourcePath: string,
  interaction: ToolInteraction,
): Promise<string> {
  interaction.action(`Finding tests related to ${sourcePath}`);
  const { files } = await discoverProjectFiles(projectRoot, {
    maxFiles: 20_000,
    signal: interaction.signal,
  });
  const stem = sourceStem(sourcePath);
  const candidates = files.filter((file) => TEST_PATTERN.test(file.relativePath)).slice(0, 2_000);
  const ranked: Array<{ path: string; score: number }> = [];
  for (const candidate of candidates) {
    let mentionsSource = false;
    if (candidate.relativePath.includes(stem)) {
      mentionsSource = true;
    } else {
      try {
        const stats = await lstat(candidate.absolutePath);
        if (stats.size <= 500_000) {
          const content = await readFile(candidate.absolutePath, "utf8");
          mentionsSource = content.includes(sourcePath) || content.includes(stem);
        }
      } catch {
        // Ignore unreadable/binary test candidates.
      }
    }
    const score = scoreTest(sourcePath, candidate.relativePath, mentionsSource);
    if (score >= 40) ranked.push({ path: candidate.relativePath, score });
  }
  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return ranked.length
    ? ranked.slice(0, 20).map((item) => item.path).join("\n")
    : "No likely related tests found.";
}

export async function findReferences(
  projectRoot: string,
  symbol: string,
  interaction: ToolInteraction,
): Promise<string> {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    throw new Error("symbol must be a simple identifier.");
  }
  interaction.action(`Finding references to ${symbol}`);
  const matches = await searchCode(projectRoot, { query: symbol, maxResults: 120 }, {
    ...interaction,
    action: () => undefined,
  });
  if (matches === "No matches found.") return matches;
  const definitions: string[] = [];
  const imports: string[] = [];
  const references: string[] = [];
  const tests: string[] = [];
  for (const line of matches.split("\n")) {
    if (TEST_PATTERN.test(line)) tests.push(line);
    else if (/\b(?:class|function|interface|type|const|let|var|def|fn|struct|enum)\b/.test(line)) definitions.push(line);
    else if (/\b(?:import|export|require|use|from)\b/.test(line)) imports.push(line);
    else references.push(line);
  }
  return [
    definitions.length ? `Definitions\n${definitions.join("\n")}` : "",
    imports.length ? `Imports/exports\n${imports.join("\n")}` : "",
    references.length ? `References\n${references.join("\n")}` : "",
    tests.length ? `Tests\n${tests.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
