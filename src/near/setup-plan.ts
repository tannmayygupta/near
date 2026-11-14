// The money plan of scripts/mainnet/setup.ts in one place, used by setup.ts (what it sends) and preflight.ts (what it estimates).
import { createHash } from 'node:crypto';
import { baseEncode } from 'near-api-js';

/** NEAR sent from the OWNER account, in the order setup.ts sends it. */
export const SETUP_PLAN = {
  subAccounts: [
    { role: 'council1', sub: 'qt-c1', near: '2', why: 'proposes in the DAO: 1 NEAR proposal bond (refunded when the proposal executes) plus gas' },
    { role: 'council2', sub: 'qt-c2', near: '0.4', why: 'votes' },
    { role: 'council3', sub: 'qt-c3', near: '0.4', why: 'votes' },
    { role: 'agent', sub: 'qt-agent', near: '1.9', why: '1.5 NEAR of it becomes the vault float' },
    { role: 'contributor', sub: 'qt-alice', near: '0.05', why: 'payee' },
    { role: 'treasurer', sub: 'qt-bob', near: '0.05', why: 'payee' },
    { role: 'funder', sub: 'qt-fee', near: '0.05', why: 'receives the service fee' },
    { role: 'mandate', sub: 'qt-mandate', near: '4.3', why: 'the mandate contract account: storage staking for the wasm plus headroom' },
  ],
  daoDepositNear: 6, // Sputnik factory `create` deposit (it retries with the amount the factory asks for, capped at 9)
  vaultNear: 1.5,    // paid by the AGENT account, not by the owner
  gasEstimateNear: 0.2, // upper estimate for ~12 transactions incl. one 150 Tgas DAO create and the wasm deploy; the real burn is reported after the run
  ownerReserveNear: 0.1, // the owner keeps its own storage + a little for gas
} as const;

export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
export const toYocto = (near: number | string) => { const [i, f = ''] = String(near).split('.'); return BigInt(i) * 10n ** 24n + BigInt((f + '0'.repeat(24)).slice(0, 24)); };
export const fromYocto = (y: bigint, dp = 4) => { const s = y.toString().padStart(25, '0'); return `${s.slice(0, -24)}.${s.slice(-24, -24 + dp)}`; };

export function estimateSetup(wasmBytes: number) {
  const subs = SETUP_PLAN.subAccounts.reduce((a, x) => a + toYocto(x.near), 0n);
  const dao = toYocto(SETUP_PLAN.daoDepositNear);
  const gas = toYocto(SETUP_PLAN.gasEstimateNear);
  const outflow = subs + dao;                                  // leaves the owner account and is not gas
  const required = outflow + gas + toYocto(SETUP_PLAN.ownerReserveNear);
  const storage = BigInt(wasmBytes) * STORAGE_YOCTO_PER_BYTE;  // what the 369 KB of code locks in the contract account
  const mandate = toYocto(SETUP_PLAN.subAccounts.find((x) => x.role === 'mandate')!.near);
  return { subAccounts: subs, daoDeposit: dao, outflow, gas, required, contractStorage: storage, contractHeadroom: mandate - storage, contractFundedEnough: mandate > storage };
}

/**
 * NEAR the owner must still be able to send for the steps that have NOT happened yet (resume-aware), plus a gas margin.
 * setup.ts compares the owner's balance with this BEFORE sending any transaction, so a shortfall stops the run with nothing sent
 * instead of leaving half the accounts created.
 */
export function remainingSetupNeed(existing: { subs: string[]; dao: boolean }, gasMarginNear = 0.3): bigint {
  const have = new Set(existing.subs);
  const subs = SETUP_PLAN.subAccounts.filter((s) => !have.has(s.sub)).reduce((a, s) => a + toYocto(s.near), 0n);
  return subs + (existing.dao ? 0n : toYocto(SETUP_PLAN.daoDepositNear)) + toYocto(gasMarginNear);
}

export const codeHashOf =(wasm: Uint8Array) => baseEncode(createHash('sha256').update(wasm).digest());
export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** True when .env text sets ALLOW_MAINNET. Consent for real money must come from the shell of the command, never from a file. */
export const envFileSetsAllowMainnet = (envText: string) => /^\s*(export\s+)?ALLOW_MAINNET\s*=/m.test(envText);
