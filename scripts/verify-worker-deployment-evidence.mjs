import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyWorkerVersionEvidence(versions, input) {
  if (!Array.isArray(versions)) {
    throw new Error("Worker versions evidence must be a JSON array");
  }
  const records = versions.filter((entry) => entry && typeof entry === "object");
  const matches = records.filter((entry) => {
    if (input.versionId && entry.id !== input.versionId) return false;
    if (input.releaseSha && entry.annotations?.["workers/tag"] !== input.releaseSha) return false;
    return true;
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Worker version record matching version=${input.versionId ?? "*"} release=${input.releaseSha ?? "*"}; found ${matches.length}`
    );
  }
  const match = matches[0];
  return {
    versionId: match.id,
    ...(input.releaseSha ? { releaseSha: input.releaseSha } : {}),
    createdOn: match.metadata?.created_on ?? null,
  };
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error("Expected --versions, plus --version-id and/or --release-sha");
    }
    parsed[flag.slice(2)] = value;
  }
  if (!parsed.versions || (!parsed["version-id"] && !parsed["release-sha"])) {
    throw new Error("Expected --versions, plus --version-id and/or --release-sha");
  }
  return parsed;
}

export function runWorkerEvidenceCli(argv) {
  const args = parseArguments(argv);
  const versions = JSON.parse(readFileSync(args.versions, "utf8"));
  return verifyWorkerVersionEvidence(versions, {
    versionId: args["version-id"],
    releaseSha: args["release-sha"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(runWorkerEvidenceCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
