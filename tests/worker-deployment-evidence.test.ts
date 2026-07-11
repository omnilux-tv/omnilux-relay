import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyWorkerVersionEvidence } from "../scripts/verify-worker-deployment-evidence.mjs";

const releaseSha = "a".repeat(40);

test("deployment evidence requires version ID and release SHA on the same record", () => {
  const versions = [
    {
      id: "version-good",
      annotations: { "workers/tag": releaseSha },
      metadata: { created_on: "2026-07-10T00:00:00.000Z" },
    },
  ];
  assert.deepEqual(
    verifyWorkerVersionEvidence(versions, {
      versionId: "version-good",
      releaseSha,
    }),
    {
      versionId: "version-good",
      releaseSha,
      createdOn: "2026-07-10T00:00:00.000Z",
    }
  );

  assert.throws(
    () => verifyWorkerVersionEvidence([
      { id: "version-good", annotations: {} },
      { id: "different-version", annotations: { "workers/tag": releaseSha } },
    ], { versionId: "version-good", releaseSha }),
    /found 0/
  );
});

test("rollback evidence requires one structural version record", () => {
  assert.deepEqual(
    verifyWorkerVersionEvidence([
      { id: "rollback-version", metadata: { created_on: "2026-07-09T00:00:00.000Z" } },
    ], { versionId: "rollback-version" }),
    {
      versionId: "rollback-version",
      createdOn: "2026-07-09T00:00:00.000Z",
    }
  );
  assert.throws(
    () => verifyWorkerVersionEvidence([], { versionId: "missing-version" }),
    /found 0/
  );
});
