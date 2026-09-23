// Decision protected: model-supplied destinations fail before request/spawn, redirects
// re-enter the same policy, and only host-owned exact local hosts can cross the default deny.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { __setDestinationLookupForTest, assertAllowedDestination, fetchWithDestinationPolicy } from "../src/destination-policy.ts";
import { createWebclawAdapter } from "../src/adapters/webclaw.ts";
import { __setWebclawSpawnForTest, __setWebclawVersionForTest, runWebclaw } from "../src/webclaw-spawn.ts";

const denyPrivate = { allowPrivateHosts: [] };
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("destination policy rejects internal ranges and mixed DNS while allowing public and configured local hosts", async () => {
  for (const url of [
    "http://0.0.0.1", "http://10.1.2.3", "http://127.0.0.1", "http://169.254.169.254",
    "http://172.16.0.1", "http://192.168.1.1", "http://100.100.100.200",
    "http://[::1]", "http://[fc00::1]", "http://[fe80::1]", "http://[::ffff:127.0.0.1]", "http://[::ffff:10.0.0.1]", "http://[::ffff:169.254.169.254]",
  ]) await assert.rejects(() => assertAllowedDestination(url, denyPrivate), { failureClass: "policy" }, url);

  await assert.rejects(() => assertAllowedDestination("http://metadata.google.internal/latest", denyPrivate, async () => { throw new Error("metadata must reject before DNS"); }), { failureClass: "policy" });
  await assert.rejects(() => assertAllowedDestination("https://mixed.example", denyPrivate, async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]), { failureClass: "policy" });
  assert.equal((await assertAllowedDestination("https://public.example", denyPrivate, publicLookup)).privateAllowed, false);
  assert.equal((await assertAllowedDestination("http://localhost:3000", { allowPrivateHosts: ["localhost"] }, async () => [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }])).privateAllowed, true);
  await assert.rejects(() => assertAllowedDestination("http://device.local", { allowPrivateHosts: ["device.local"] }, async () => [{ address: "169.254.1.2", family: 4 }]), { failureClass: "policy" }, "link-local cannot use the local-development escape");
});

test("manual redirect handling blocks a public-to-private hop before the second request", async () => {
  const calls = [];
  const fakeFetch = async (input) => {
    calls.push(String(input));
    return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  };
  await assert.rejects(() => fetchWithDestinationPolicy("https://public.example/start", {}, denyPrivate, fakeFetch, 10, publicLookup), { failureClass: "policy" });
  assert.deepEqual(calls, ["https://public.example/start"]);
});

test("manual redirect handling reports requested and effective public URLs", async () => {
  const fakeFetch = async (input) => String(input).endsWith("/start")
    ? new Response("", { status: 302, headers: { location: "/final" } })
    : new Response("ok", { status: 200 });
  const result = await fetchWithDestinationPolicy("https://public.example/start", {}, denyPrivate, fakeFetch, 10, publicLookup);
  assert.equal(result.requestedUrl, "https://public.example/start");
  assert.equal(result.effectiveUrl, "https://public.example/final");
});

test("host-owned configuration permits an exact local host through address-pinned direct fetch", async () => {
  let spawnCalls = 0;
  let requestHost;
  const server = createServer((request, response) => {
    requestHost = request.headers.host;
    response.writeHead(200, { "content-type": "text/markdown" });
    response.end("# local docs");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  __setDestinationLookupForTest(async () => [{ address: "127.0.0.1", family: 4 }]);
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; throw new Error("configured local access must not spawn webclaw"); });
  try {
    const adapter = createWebclawAdapter({ destinationPolicy: { allowPrivateHosts: ["local.test"] } });
    const result = await adapter.fetch({ operation: "fetch", mode: "page", url: `http://local.test:${address.port}/docs`, provider: "webclaw" }, { timeoutMs: 1000, persist() {} });
    assert.equal(result[0].content, "# local docs");
    assert.equal(requestHost, `local.test:${address.port}`);
    assert.equal(spawnCalls, 0);
  } finally {
    __setDestinationLookupForTest(undefined);
    __setWebclawSpawnForTest(undefined);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("blocked destinations stop both direct requests and webclaw subprocesses", async () => {
  let fetchCalls = 0;
  await assert.rejects(() => fetchWithDestinationPolicy("http://127.0.0.1", {}, denyPrivate, async () => { fetchCalls += 1; return new Response("no"); }), { failureClass: "policy" });
  assert.equal(fetchCalls, 0);

  let spawnCalls = 0;
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; return { ok: true, ms: 1, stdout: "", stderr: "" }; });
  try {
    await assert.rejects(() => runWebclaw(["http://127.0.0.1"], { destination: { url: "http://127.0.0.1", policy: denyPrivate } }), { failureClass: "policy" });
    assert.equal(spawnCalls, 0);
  } finally {
    __setWebclawSpawnForTest(undefined);
  }
});

test("URL-bearing webclaw spawns require the security-reviewed binary version", async () => {
  let spawnCalls = 0;
  __setDestinationLookupForTest(publicLookup);
  __setWebclawVersionForTest(async () => "webclaw 0.6.15");
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; return { ok: true, ms: 1, stdout: "", stderr: "" }; });
  try {
    await assert.rejects(() => runWebclaw(["https://public.example"], { destination: { url: "https://public.example", policy: denyPrivate } }), { failureClass: "policy" });
    assert.equal(spawnCalls, 0);
  } finally {
    __setDestinationLookupForTest(undefined);
    __setWebclawVersionForTest(undefined);
    __setWebclawSpawnForTest(undefined);
  }
});

test("URL-bearing webclaw spawns accept an in-range newer binary (patch drift does not break fetch)", async () => {
  let spawnCalls = 0;
  __setDestinationLookupForTest(publicLookup);
  __setWebclawVersionForTest(async () => "webclaw 0.6.23");
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; return { ok: true, ms: 1, stdout: "", stderr: "" }; });
  try {
    await runWebclaw(["https://public.example"], { destination: { url: "https://public.example", policy: denyPrivate } });
    assert.equal(spawnCalls, 1, "an in-range version must reach the spawn");
  } finally {
    __setDestinationLookupForTest(undefined);
    __setWebclawVersionForTest(undefined);
    __setWebclawSpawnForTest(undefined);
  }
});

test("a failed webclaw version check re-reads on the next call instead of poisoning the session", async () => {
  let reads = 0;
  let spawnCalls = 0;
  __setDestinationLookupForTest(publicLookup);
  __setWebclawVersionForTest(async () => { reads += 1; return reads === 1 ? "webclaw 0.6.15" : "webclaw 0.6.23"; });
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; return { ok: true, ms: 1, stdout: "", stderr: "" }; });
  try {
    const opts = { destination: { url: "https://public.example", policy: denyPrivate } };
    await assert.rejects(() => runWebclaw(["https://public.example"], opts), { failureClass: "policy" });
    await runWebclaw(["https://public.example"], opts);
    assert.equal(reads, 2, "the second call must re-run the version check");
    assert.equal(spawnCalls, 1, "only the aligned second call may spawn");
  } finally {
    __setDestinationLookupForTest(undefined);
    __setWebclawVersionForTest(undefined);
    __setWebclawSpawnForTest(undefined);
  }
});

test("URL-bearing webclaw spawns reject a binary above the 0.x ceiling with owned advice", async () => {
  let spawnCalls = 0;
  __setDestinationLookupForTest(publicLookup);
  __setWebclawVersionForTest(async () => "webclaw 0.7.0");
  __setWebclawSpawnForTest(async () => { spawnCalls += 1; return { ok: true, ms: 1, stdout: "", stderr: "" }; });
  try {
    await assert.rejects(
      () => runWebclaw(["https://public.example"], { destination: { url: "https://public.example", policy: denyPrivate } }),
      (error) => error.failureClass === "policy" && /0\.7\.0/.test(error.message) && /supported range/.test(error.message) && typeof error.advice === "string" && /brew upgrade|webclaw releases/.test(error.advice),
    );
    assert.equal(spawnCalls, 0);
  } finally {
    __setDestinationLookupForTest(undefined);
    __setWebclawVersionForTest(undefined);
    __setWebclawSpawnForTest(undefined);
  }
});
