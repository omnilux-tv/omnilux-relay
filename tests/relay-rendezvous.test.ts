import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { RelayRendezvous, relayWorkerTestHooks } from "../src/cloudflare/index.ts";

type StoredRoute = {
  shardKey: string;
  connectionId: string;
  updatedAt: number;
  expiresAt: number;
};

const routeKeyFor = (serverId: string) =>
  createHash("sha256").update(serverId).digest("base64url");

const internalRequest = (
  routeKey: string,
  method: string,
  body?: Record<string, unknown>
) =>
  new Request(`https://relay.internal/_relay-internal/routes/${routeKey}`, {
    method,
    headers: {
      "X-OmniLux-Relay-Internal": "relay-worker-internal-v1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const createRendezvous = (input: {
  ttlMs?: number;
  beforePut?: () => void | Promise<void>;
}) => {
  const records = new Map<string, StoredRoute>();
  const storage = {
    get: async <T>(key: string) => records.get(key) as T | undefined,
    put: async (key: string, value: StoredRoute) => {
      await input.beforePut?.();
      records.set(key, value);
    },
    delete: async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) records.delete(item);
      return true;
    },
    list: async () => {
      throw new Error("readiness must not scan route storage");
    },
  };
  const env = {
    RELAY_RENDEZVOUS_TTL_MS: String(input.ttlMs ?? 60_000),
  };
  const rendezvous = new RelayRendezvous(
    { storage } as never,
    env as never
  );
  return { rendezvous, records };
};

test("rendezvous partitions distribute server hashes and readiness stays O(1)", async () => {
  const partitions = new Set(
    Array.from({ length: 128 }, (_, index) =>
      relayWorkerTestHooks.rendezvousPartitionForRouteKey(
        routeKeyFor(`server-${index}`),
        64
      )
    )
  );
  assert.ok(partitions.size >= 32);

  const { rendezvous } = createRendezvous({});
  const response = await rendezvous.fetch(new Request(
    "https://relay.internal/_relay-internal/readyz",
    { headers: { "X-OmniLux-Relay-Internal": "relay-worker-internal-v1" } }
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("rendezvous publishes a route only after the coordinator confirms the live tunnel", async () => {
  let releaseLiveness!: () => void;
  const livenessGate = new Promise<void>((resolve) => {
    releaseLiveness = resolve;
  });
  const { rendezvous } = createRendezvous({
    beforePut: async () => {
      await livenessGate;
    },
  });
  const serverId = "delayed-server";
  const routeKey = routeKeyFor(serverId);
  const publish = rendezvous.fetch(internalRequest(routeKey, "PUT", {
    serverId,
    shardKey: "shard-new",
    connectionId: "connection-new",
    acceptedAt: 200,
  }));

  await delay(10);
  const before = await rendezvous.fetch(internalRequest(routeKey, "GET"));
  assert.equal(before.status, 404);
  releaseLiveness();
  assert.equal((await publish).status, 200);
  assert.equal((await rendezvous.fetch(internalRequest(routeKey, "GET"))).status, 200);
});

test("expired and absent routes recover only for the same live connection", async () => {
  const { rendezvous } = createRendezvous({
    ttlMs: 5,
  });
  const serverId = "server-ttl";
  const routeKey = routeKeyFor(serverId);
  const routeBody = {
    serverId,
    shardKey: "shard-new",
    connectionId: "connection-new",
    acceptedAt: 200,
  };

  assert.equal((await rendezvous.fetch(internalRequest(routeKey, "PUT", routeBody))).status, 200);
  await delay(10);
  assert.equal((await rendezvous.fetch(internalRequest(routeKey, "GET"))).status, 404);
  assert.equal((await rendezvous.fetch(internalRequest(routeKey, "PATCH", routeBody))).status, 200);

  const stale = await rendezvous.fetch(internalRequest(routeKey, "PATCH", {
    serverId,
    shardKey: "shard-old",
    connectionId: "connection-old",
    acceptedAt: 100,
  }));
  assert.equal(stale.status, 409);
  const current = await rendezvous.fetch(internalRequest(routeKey, "GET"));
  assert.equal((await current.json() as { route: StoredRoute }).route.connectionId, "connection-new");

  assert.equal((await rendezvous.fetch(internalRequest(routeKey, "DELETE", routeBody))).status, 200);
  const deadRecovery = await rendezvous.fetch(internalRequest(routeKey, "PATCH", {
    serverId,
    shardKey: "shard-old",
    connectionId: "connection-old",
    acceptedAt: 100,
  }));
  assert.equal(deadRecovery.status, 409);
  assert.equal((await rendezvous.fetch(internalRequest(routeKey, "GET"))).status, 404);

  assert.equal((await rendezvous.fetch(internalRequest(routeKey, "PATCH", routeBody))).status, 200);
});
