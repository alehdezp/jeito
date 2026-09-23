// Release boundary for model-supplied destinations. Webclaw 0.6.16 independently
// enforces the same policy at DNS resolution and every redirect; direct fetches use
// fetchWithDestinationPolicy so redirect hops cannot leave this boundary.
import { lookup as nodeLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { ProviderError } from "./failures.ts";

export interface DestinationPolicy {
  allowPrivateHosts: string[];
}

export interface AllowedDestination {
  url: URL;
  privateAllowed: boolean;
  addresses: Array<{ address: string; family: number }>;
}

export type DestinationLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
export type DestinationFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(network, prefix, "ipv6");

const localDevelopment = new BlockList();
for (const [network, prefix] of [["10.0.0.0", 8], ["127.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) localDevelopment.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::1", 128], ["fc00::", 7]] as const) localDevelopment.addSubnet(network, prefix, "ipv6");

const metadataHosts = new Set(["metadata.google.internal", "metadata.google", "instance-data"]);
let lookupImpl: DestinationLookup = nodeLookup as DestinationLookup;

/** Test-only resolver seam; production always uses node:dns/promises. */
export function __setDestinationLookupForTest(lookup: DestinationLookup | undefined): void {
  lookupImpl = lookup ?? nodeLookup as DestinationLookup;
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function addressType(address: string): "ipv4" | "ipv6" {
  return isIP(address) === 6 ? "ipv6" : "ipv4";
}

function isBlocked(address: string): boolean {
  return blocked.check(address, addressType(address));
}

function isLocalDevelopment(address: string): boolean {
  return localDevelopment.check(address, addressType(address));
}

export async function assertAllowedDestination(raw: string, policy: DestinationPolicy, lookup: DestinationLookup = lookupImpl): Promise<AllowedDestination> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProviderError("invalid_input", `Invalid destination URL: ${raw}`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new ProviderError("policy", "Only HTTP(S) destinations with a host are allowed");
  const host = normalizedHost(url.hostname);
  if (metadataHosts.has(host)) throw new ProviderError("policy", `Blocked cloud-metadata destination: ${host}`);
  const configuredLocal = new Set(policy.allowPrivateHosts.map(normalizedHost)).has(host);
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch (error) { throw new ProviderError("network", `Destination host did not resolve: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!addresses.length) throw new ProviderError("network", "Destination host did not resolve to any address");
  let privateAllowed = false;
  for (const { address } of addresses) {
    if (!isBlocked(address)) continue;
    if (configuredLocal && isLocalDevelopment(address)) { privateAllowed = true; continue; }
    throw new ProviderError("policy", `Blocked private or internal destination: ${host}`);
  }
  return { url, privateAllowed, addresses };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function requestPinnedAddress(url: URL, init: RequestInit, selected: { address: string; family: number }): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  headers.host ??= url.host;
  headers["accept-encoding"] ??= "identity";
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: url.protocol,
      hostname: selected.address,
      family: selected.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers,
      signal: init.signal ?? undefined,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      const status = incoming.statusCode ?? 500;
      const body = [101, 204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream;
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
    });
    req.on("error", reject);
    req.end();
  });
}

function requestPinned(url: URL, init: RequestInit, destination: AllowedDestination): Promise<Response> {
  const selected = destination.addresses.find(({ family }) => family === 4) ?? destination.addresses[0];
  return requestPinnedAddress(url, init, selected);
}

export async function fetchWithDestinationPolicy(
  raw: string,
  init: RequestInit,
  policy: DestinationPolicy,
  fetchImpl?: DestinationFetch,
  maxRedirects = 10,
  lookup: DestinationLookup = lookupImpl,
): Promise<{ response: Response; requestedUrl: string; effectiveUrl: string; privateAllowed: boolean }> {
  const requested = new URL(raw).href;
  let current = requested;
  let privateAllowed = false;
  for (let redirects = 0; ; redirects++) {
    const allowed = await assertAllowedDestination(current, policy, lookup);
    privateAllowed ||= allowed.privateAllowed;
    const response = fetchImpl
      ? await fetchImpl(allowed.url, { ...init, redirect: "manual" })
      : await requestPinned(allowed.url, { ...init, redirect: "manual" }, allowed);
    if (!REDIRECT_STATUSES.has(response.status)) return { response, requestedUrl: requested, effectiveUrl: response.url || allowed.url.href, privateAllowed };
    if (redirects >= maxRedirects) throw new ProviderError("policy", `Too many redirects (>${maxRedirects})`);
    const location = response.headers.get("location");
    if (!location) return { response, requestedUrl: requested, effectiveUrl: response.url || allowed.url.href, privateAllowed };
    try { await response.body?.cancel(); } catch { /* response body may already be closed */ }
    current = new URL(location, allowed.url).href;
  }
}
