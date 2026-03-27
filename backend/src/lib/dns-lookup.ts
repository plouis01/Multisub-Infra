import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Thin wrapper around dns/promises.lookup so it can be easily mocked in tests.
 */
export async function resolveDns(
  hostname: string,
): Promise<{ address: string }> {
  return dnsLookup(hostname);
}
