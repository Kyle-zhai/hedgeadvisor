/**
 * lib/execute/l2-noncustodial.ts — L2 NON-CUSTODIAL execution (SCAFFOLD, GATED).
 *
 * 🔒 DISABLED BY DEFAULT. L2 places real orders with real funds. Per
 * HedgeAdvisor-Execution-Compliance.md it must NOT ship until:
 *   1. Counsel confirms "construct EIP-712 order + relay user-signed order +
 *      per-user creds" is non-custodial (no MSB/MTL).  [§8.1]
 *   2. Polymarket grants written API/builder terms for third-party order relay. [§7]
 *   3. US users are geo-blocked off the offshore venue; OFAC screening in place. [§3]
 *
 * Non-custodial invariants this module MUST preserve (do not weaken):
 *   - Keys live ONLY in the user's wallet. We never see a private key or secret.
 *   - The USER signs every EIP-712 order in their own wallet (clob-client-v2,
 *     createOrDeriveApiKey + createOrder). We only RELAY the already-signed bytes.
 *   - Token approvals go to Polymarket's own contracts, never a HedgeAdvisor address.
 *   - No session keys, no standing spend authority, no auto-execute.
 *
 * VERIFY before building (2026-06-15 findings):
 *   - 🔴 Collateral is pUSD (not USDC.e) since the 2026-04-28 V2 cutover; there is a
 *     USDC→pUSD wrap step. Pull pUSD + all contract addresses LIVE from
 *     docs.polymarket.com/resources/contracts and verify bytecode on PolygonScan.
 *     Do NOT hardcode the pUSD address (a candidate collides with legacy Aave LEND).
 *   - 🔴 clob.polymarket.com blocks browser cross-origin → relay via our server
 *     (this file's RELAY_ENABLED path), don't fetch CLOB directly from the client.
 *   - SDK is @polymarket/clob-client-v2 (viem-based); exported class is `ClobClient`,
 *     options-object constructor. Pin the version; copy the constructor from the README.
 *   - MVP wallets: EOA (signatureType 0) + Gnosis Safe (2) only. Magic/POLY_PROXY/1271
 *     have open V2 auth bugs (#64-66, #339).
 */

export const L2_ENABLED = process.env.HEDGE_L2_ENABLED === "true"; // default false

export type SignatureType = 0 | 2; // EOA | Gnosis Safe (MVP only)

export interface L2Guard {
  enabled: boolean;
  blockers: string[];
}

/** Returns why L2 is (or isn't) allowed to run. Fail-closed by default. */
export function l2Guard(opts: { isUsUser: boolean; counselSignedOff?: boolean; tosCleared?: boolean }): L2Guard {
  const blockers: string[] = [];
  if (!L2_ENABLED) blockers.push("HEDGE_L2_ENABLED is not 'true' (feature flag off).");
  if (opts.isUsUser) blockers.push("US user: L2-on-global is blocked; route to L0/L1 (Polymarket US).");
  if (!opts.counselSignedOff) blockers.push("Counsel non-custodial/IB opinion not on file (§8.1).");
  if (!opts.tosCleared) blockers.push("Polymarket commercial relay terms not confirmed (§7).");
  return { enabled: blockers.length === 0, blockers };
}

/**
 * Placeholder for the client-side signing flow. Intentionally NOT implemented —
 * it must be authored against the pinned clob-client-v2 README + verified contracts,
 * and only after the compliance gates above. See the compliance doc for the full flow.
 */
export function l2NotImplemented(): never {
  throw new Error(
    "L2 non-custodial execution is gated. See HedgeAdvisor-Execution-Compliance.md §8 before enabling.",
  );
}
