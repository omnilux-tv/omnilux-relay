import assert from "node:assert/strict";
import { test } from "node:test";

import { relayWorkerTestHooks } from "../src/cloudflare/index.ts";

test("relay attach attempt IDs are stable, token-scoped, and non-reversible identifiers", async () => {
  const token = "olrg_secret-grant-material";
  const first = await relayWorkerTestHooks.attachAttemptIdForToken(token);
  const retry = await relayWorkerTestHooks.attachAttemptIdForToken(token);
  const other = await relayWorkerTestHooks.attachAttemptIdForToken(`${token}-other`);
  const connection = await relayWorkerTestHooks.connectionIdForToken(token);
  const retryConnection = await relayWorkerTestHooks.connectionIdForToken(token);

  assert.equal(first, retry);
  assert.match(first, /^raa_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, other);
  assert.equal(first.includes(token), false);
  assert.equal(connection, retryConnection);
  assert.match(connection, /^rcn_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(connection.slice(4), first.slice(4));
  assert.equal(connection.includes(token), false);
});

test("Cloudflare response cancellation reaches the owning relay coordinator", async () => {
  let cancellationRequest: Request | null = null;
  const cancellationObserved = Promise.withResolvers<void>();
  const env = {
    RELAY_COORDINATOR: {
      idFromName(name: string) {
        assert.equal(name, "server-shard");
        return "coordinator-id";
      },
      get(id: string) {
        assert.equal(id, "coordinator-id");
        return {
          async fetch(request: Request) {
            cancellationRequest = request;
            cancellationObserved.resolve();
            return new Response(JSON.stringify({ ok: true }));
          },
        };
      },
    },
  };
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const sourceWriter = source.writable.getWriter();
  void sourceWriter.closed.catch(() => undefined);
  const requestController = new AbortController();
  const response = new Response(source.readable, {
    headers: { "X-OmniLux-Relay-Request-Id": "request-123" },
  });

  const exposed = relayWorkerTestHooks.exposeCoordinatorResponse(
    env as never,
    "server-shard",
    response,
    requestController.signal
  );
  assert.equal(exposed.headers.has("X-OmniLux-Relay-Request-Id"), false);
  const reader = exposed.body?.getReader();
  assert.ok(reader);
  const write = sourceWriter.write(new TextEncoder().encode("first chunk"));
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first chunk");
  await write;

  await reader.cancel("browser stopped reading");
  await cancellationObserved.promise;
  assert.ok(cancellationRequest);
  assert.equal(new URL(cancellationRequest.url).pathname, "/_relay-internal/http-cancel");
  assert.equal(
    cancellationRequest.headers.get("X-OmniLux-Relay-Internal"),
    "relay-worker-internal-v1"
  );
  assert.deepEqual(await cancellationRequest.json(), {
    requestId: "request-123",
    reason: "Relay HTTP response consumer cancelled: browser stopped reading",
  });
});
