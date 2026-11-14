// ONE REAL NEAR INTENTS SETTLEMENT on NEAR MAINNET, run by the OWNER with the OWNER's own funded account. Nothing here is DAO- or agent-driven.
//
// What it does (about 0.5 wNEAR, hard cap 1 NEAR): a fresh implicit account (key saved to data/secret, git-ignored) is funded by your account, wraps NEAR to
// wNEAR, asks the 1Click API for a LIVE quote wNEAR -> USDC (NEAR), ft_transfers the wNEAR to the quote's deposit address, waits for 1Click to settle, then
// checks that the USDC balance really rose by at least the quote's minAmountOut. Every transaction is recorded with a nearblocks link in
// data/demo-run/intents-run.json (copied to app/public/demo-run/). Read docs/DEFI.md ("Real settlement") for what this does and does not prove.
//
// MODES
//   --dry         no key, no funds, no files: prints the plan, reads public state and shows a DRY quote (dry:true). Safe anywhere.
//   --quote-only  asks 1Click for ONE real quote (dry:false) for a throwaway account to show the response shape. Generates a deposit address, deposits nothing.
//   (neither)     the real run. Refuses unless ALLOW_MAINNET=1 AND CONFIRM_INTENTS_SPEND=<the amount in NEAR> equals INTENTS_AMOUNT_NEAR (default 0.5).
//
// Run:  $env:ALLOW_MAINNET='1'; $env:CONFIRM_INTENTS_SPEND='0.5'; npx tsx --env-file=.env scripts/mainnet/intents-settle.ts
// Env:  MAINNET_FUNDER_ACCOUNT, MAINNET_FUNDER_KEY (your funded mainnet account and its ed25519 key; read from the environment only, never printed or written;
//       QT_FUNDER_ACCOUNT / QT_FUNDER_KEY are accepted as fallbacks), INTENTS_AMOUNT_NEAR (default 0.5), ONECLICK_JWT (optional partner key: saves 0.25%).
// Exit: 0 settled and verified | 1 error before any deposit | 2 refused by a guard | 3 deposit sent, outcome unknown (PARKED) | 4 SUCCESS but balance check failed | 5 refunded | 6 failed
import { KeyPair } from 'near-api-js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RPC, accountFor, callTx, providerFor, TGAS } from '../../src/near/chain.js';
import { dryQuoteFull } from '../../src/near/intents.js';
import { LiveGuardError, SPEND_CAP_YOCTO, checkSettleGuards, getStatus, implicitAccountId, liveQuote, parseNearAmount, submitDeposit, waitForStatus } from '../../src/near/intents-live.js';
import { DEST_ASSET, GAS_FLOAT, ORIGIN_ASSET, USDC, WRAP, explorerTx, runSettlement, type Journal, type SettlePort } from '../../src/near/intents-settle.js';

const KEY_FILE = 'data/secret/mainnet-intents-key.json';
const JOURNAL_FILE = 'data/secret/mainnet-intents-journal.json';
const RUN_FILE = 'data/demo-run/intents-run.json';
const PUBLIC_RUN_FILE = 'app/public/demo-run/intents-run.json';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry'), QUOTE_ONLY = argv.includes('--quote-only');
const secrets: string[] = []; // every secret this process holds; scrubbed from anything printed
const scrub = (s: string) => secrets.reduce((acc, x) => (x ? acc.split(x).join('***') : acc), s);
function die(code: number, msg: string): never { console.error(scrub(msg)); process.exit(code); }
for (const a of argv) if (a !== '--dry' && a !== '--quote-only') die(1, `unknown argument "${a}" (allowed: --dry, --quote-only)`);
if (DRY && QUOTE_ONLY) die(1, 'use either --dry or --quote-only, not both');

const NEAR_RPC = RPC.mainnet;
const provider = providerFor(NEAR_RPC);
const AMOUNT_NEAR = process.env.INTENTS_AMOUNT_NEAR ?? '0.5';
const JWT = process.env.ONECLICK_JWT || undefined;
if (JWT) secrets.push(JWT);
/** the configured amount for the two no-funds modes: a plain decimal, above 0, at most the 1 NEAR cap (the real run uses checkSettleGuards instead) */
const previewAmount = (): bigint => {
  let a: bigint;
  try { a = parseNearAmount(AMOUNT_NEAR); } catch (e) { return die(2, (e as Error).message); }
  if (a <= 0n || a > SPEND_CAP_YOCTO) die(2, `INTENTS_AMOUNT_NEAR=${AMOUNT_NEAR} must be above 0 and at most 1`);
  return a;
};
const nearStr = (y: bigint, shown = 4) => { const s = y.toString().padStart(25, '0'); return `${s.slice(0, -24)}.${s.slice(-24).slice(0, shown)}`; };
const usdcStr = (y: bigint) => { const s = y.toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`; };

// ---- shared read-only helpers
async function assertMainnetRpc() {
  const id = await provider.getNetworkId();
  if (id !== 'mainnet') die(1, `the RPC at ${NEAR_RPC} reports network "${id}", not "mainnet": refusing (check NEAR_MAINNET_RPC)`);
}
const view = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}) => (await provider.callFunction({ contractId, method, args })) as T;
const nearBalance = async (id: string): Promise<bigint | null> => {
  try { return BigInt((await provider.viewAccount({ accountId: id })).amount); }
  catch (e) { if ((e as Error).constructor.name === 'AccountDoesNotExistError' || /does not exist/i.test((e as Error).message)) return null; throw e; }
};
const ftBalance = async (token: string, id: string) => BigInt(await view<string>(token, 'ft_balance_of', { account_id: id }));
const storageRegistered = async (token: string, id: string) => (await view<unknown>(token, 'storage_balance_of', { account_id: id })) !== null;
const storageMin = async (token: string) => BigInt((await view<{ min: string }>(token, 'storage_balance_bounds')).min);

function plan(implicit: string) {
  console.log(`plan (amount ${AMOUNT_NEAR} NEAR, settlement account ${implicit}):`);
  console.log(`  1. funder sends ${nearStr(parseNearAmount(AMOUNT_NEAR) + GAS_FLOAT)} NEAR to the implicit account (swap amount + 0.06 float for storage and gas; the rest stays there)`);
  console.log(`  2. implicit account registers on ${WRAP} (storage_deposit, 0.00125 NEAR)`);
  console.log(`  3. implicit account wraps ${AMOUNT_NEAR} NEAR: ${WRAP} near_deposit`);
  console.log(`  4. implicit account registers on the USDC contract (storage_deposit, 0.00125 NEAR)`);
  console.log(`  5. live 1Click quote (dry:false): ${ORIGIN_ASSET} -> ${DEST_ASSET}, recipient = refundTo = the implicit account`);
  console.log(`  6. register the quote's deposit address on ${WRAP} if needed (0.00125 NEAR)`);
  console.log(`  7. DEPOSIT: ft_transfer of ${AMOUNT_NEAR} wNEAR to the deposit address (the only step that sends the swap amount; never repeated)`);
  console.log('  8. POST /v0/deposit/submit, poll GET /v0/status until SUCCESS | REFUNDED | FAILED');
  console.log('  9. verify the USDC balance rose by at least minAmountOut, write data/demo-run/intents-run.json');
}

// ---- --dry
if (DRY) {
  const amount = previewAmount();
  await assertMainnetRpc();
  const kp = KeyPair.fromRandom('ed25519'), implicit = implicitAccountId(kp.getPublicKey().data);
  console.log('DRY RUN: nothing is sent, no key is saved, no file is written. A throwaway key was generated in memory and is discarded.');
  plan(implicit);
  console.log('\nread-only checks on mainnet:');
  console.log(`  ${WRAP} storage_balance_bounds.min = ${nearStr(await storageMin(WRAP), 5)} NEAR; USDC contract = ${nearStr(await storageMin(USDC), 5)} NEAR`);
  const fid = process.env.MAINNET_FUNDER_ACCOUNT || process.env.QT_FUNDER_ACCOUNT;
  if (fid) { const b = await nearBalance(fid); console.log(`  funder ${fid}: ${b === null ? 'DOES NOT EXIST on mainnet' : `${nearStr(b)} NEAR (needs about ${nearStr(amount + GAS_FLOAT + 10n ** 22n)})`}`); }
  else console.log('  funder: MAINNET_FUNDER_ACCOUNT is not set (it is required for the real run)');
  try {
    const q = await dryQuoteFull({ originAsset: ORIGIN_ASSET, destinationAsset: DEST_ASSET, amount: amount.toString(), recipient: implicit, refundTo: implicit });
    console.log(`  DRY quote (dry:true, no deposit address): in ${nearStr(BigInt(q.amountIn))} wNEAR -> out ${usdcStr(BigInt(q.amountOut))} USDC, min ${usdcStr(BigInt(q.minAmountOut ?? '0'))}, withdraw fee ${q.withdrawFee}, eta ${q.timeEstimateS}s, about US$${Number(q.amountInUsd).toFixed(2)}`);
  } catch (e) { console.log(`  DRY quote failed: ${(e as Error).message}`); }
  console.log('\nDRY RUN complete. To run for real: set ALLOW_MAINNET=1 and CONFIRM_INTENTS_SPEND=' + AMOUNT_NEAR + ', then run without --dry.');
  process.exit(0);
}

// ---- --quote-only
if (QUOTE_ONLY) {
  const amount = previewAmount();
  const kp = KeyPair.fromRandom('ed25519'), implicit = implicitAccountId(kp.getPublicKey().data);
  console.log('QUOTE ONLY: one real 1Click quote (dry:false) for a throwaway account. It creates a deposit address; nothing is deposited, no key is used, no file is written.');
  const q = await liveQuote({ originAsset: ORIGIN_ASSET, destinationAsset: DEST_ASSET, amount: amount.toString(), recipient: implicit, refundTo: implicit, jwt: JWT });
  console.log(JSON.stringify(q, null, 2));
  try { console.log(`deposit address registered on ${WRAP} already? ${await storageRegistered(WRAP, q.depositAddress)}`); } catch (e) { console.log(`storage check failed: ${(e as Error).message}`); }
  try { const s = await getStatus({ depositAddress: q.depositAddress, jwt: JWT }); console.log('status right after the quote:', JSON.stringify(s)); }
  catch (e) { console.log('status right after the quote (no deposit yet):', (e as Error).message); }
  process.exit(0);
}

// ---- the real run: every guard BEFORE anything is read or written
let amount: bigint;
try { amount = checkSettleGuards(process.env, AMOUNT_NEAR); } catch (e) { die(2, (e as Error).message); }
const funderId = process.env.MAINNET_FUNDER_ACCOUNT || process.env.QT_FUNDER_ACCOUNT || '';
const funderKey = process.env.MAINNET_FUNDER_KEY || process.env.QT_FUNDER_KEY || '';
if (!funderId || !funderKey) die(1, 'set MAINNET_FUNDER_ACCOUNT and MAINNET_FUNDER_KEY (your funded mainnet account and its ed25519 secret key) in .env');
secrets.push(funderKey);
if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,}$/.test(funderKey)) die(1, 'MAINNET_FUNDER_KEY must look like ed25519:<base58>');
await assertMainnetRpc();

// the settlement key: generated once, saved BEFORE the first transaction (a crash can never orphan funds), never overwritten
const ignored = spawnSync('git', ['check-ignore', '-q', KEY_FILE]).status === 0;
if (!ignored) die(1, `${KEY_FILE} is not git-ignored (or git is unavailable): refusing to create a secret key file that could be committed`);
let secretKey: string;
if (existsSync(KEY_FILE)) {
  const saved = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { accountId: string; secretKey: string };
  const kp = KeyPair.fromString(saved.secretKey as any);
  if (implicitAccountId(kp.getPublicKey().data) !== saved.accountId) die(1, `${KEY_FILE} is inconsistent (account id does not match its key): refusing`);
  secretKey = saved.secretKey; console.log(`reusing the settlement key in ${KEY_FILE}`);
} else {
  const kp = KeyPair.fromRandom('ed25519');
  secretKey = kp.toString();
  mkdirSync('data/secret', { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify({ accountId: implicitAccountId(kp.getPublicKey().data), publicKey: kp.getPublicKey().toString(), secretKey, createdAt: new Date().toISOString(), note: 'settlement account of scripts/mainnet/intents-settle.ts; whoever holds this file controls the account' }, null, 2), { flag: 'wx' });
  console.log(`generated a settlement key and saved it to ${KEY_FILE} (git-ignored). BACK IT UP if the run is interrupted.`);
}
secrets.push(secretKey);
const implicit = implicitAccountId(KeyPair.fromString(secretKey as any).getPublicKey().data);
const funder = accountFor(NEAR_RPC, funderId, funderKey);
const settler = accountFor(NEAR_RPC, implicit, secretKey);
console.log(`network mainnet | funder ${funderId} | settlement account ${implicit} | amount ${AMOUNT_NEAR} NEAR (cap 1) | funder outflow at most ${nearStr(amount + GAS_FLOAT)} NEAR`);
plan(implicit);

const txHashOf = (o: any): string => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? '';
const requireHash = (h: string, what: string) => { if (!h) throw new Error(`${what}: the RPC returned no transaction hash`); return h; };
const port: SettlePort = {
  nowS: () => Math.floor(Date.now() / 1000),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.log(scrub(m)),
  nearBalance, ftBalance, storageRegistered, storageMin,
  transferNear: async (to, amt) => requireHash(txHashOf(await funder.transfer({ receiverId: to, amount: amt })), 'funding transfer'),
  storageDeposit: async (token, forAccount, amt) => requireHash((await callTx(settler, token, 'storage_deposit', { account_id: forAccount, registration_only: true }, TGAS(30), amt)).txHash, 'storage_deposit'),
  nearDeposit: async (amt) => requireHash((await callTx(settler, WRAP, 'near_deposit', {}, TGAS(30), amt)).txHash, 'near_deposit'),
  ftTransfer: async (token, to, amt) => requireHash((await callTx(settler, token, 'ft_transfer', { receiver_id: to, amount: amt.toString(), memo: null }, TGAS(50), 1n)).txHash, 'ft_transfer'),
  liveQuote: (input) => liveQuote({ ...input, jwt: JWT }),
  submitDeposit: (input) => submitDeposit({ ...input, jwt: JWT }),
  waitForStatus: (input) => waitForStatus({ ...input, jwt: JWT, onUpdate: (s) => console.log(`  1Click status: ${s.status}`) }),
  loadJournal: () => (existsSync(JOURNAL_FILE) ? (JSON.parse(readFileSync(JOURNAL_FILE, 'utf8')) as Journal) : undefined),
  saveJournal: (j) => { mkdirSync('data/secret', { recursive: true }); writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2)); },
};

let j: Journal;
try {
  j = await runSettlement(port, { implicit, funder: funderId, amount, recoveredDepositTx: process.env.INTENTS_DEPOSIT_TX || undefined });
} catch (e) {
  die(e instanceof LiveGuardError ? 2 : 1, `STOPPED BEFORE ANY DEPOSIT: ${(e as Error).message}\n(nothing was deposited to 1Click; re-running continues where this stopped. Journal: ${JOURNAL_FILE})`);
}

const last = j!.status?.last;
const deposit = j!.deposit;
if (j!.outcome !== 'settled') {
  console.error(scrub(`\nOUTCOME: ${j!.outcome}\n${j!.outcomeNote ?? ''}`));
  if (j!.quote) console.error(`deposit address: ${j!.quote.depositAddress}\ndeposit tx:      ${deposit ? explorerTx(deposit.txHash) : '(none recorded)'}\nstatus:          https://1click.chaindefuser.com/v0/status?depositAddress=${j!.quote.depositAddress}\naccount:         https://nearblocks.io/address/${j!.implicit}\njournal:         ${JOURNAL_FILE} (full record; do not delete before the outcome is settled)`);
  process.exit({ unknown: 3, verification_failed: 4, refunded: 5, failed: 6 }[j!.outcome as string] ?? 1);
}

// ---- settled and verified on chain: write the recorded run
const q = j!.quote!;
const b0 = j!.balancesBefore!, b1 = j!.balancesAfter!;
const delta = (a: string, b: string) => (BigInt(b) - BigInt(a)).toString();
const run = {
  recordedAt: new Date().toISOString(),
  network: 'NEAR mainnet', kind: 'one real NEAR Intents settlement via the 1Click API',
  honesty: 'REAL mainnet transactions and a real 1Click swap, but run by the OWNER with the OWNER\'s own funded account: it is NOT executed by the DAO or by the bounded agent, there is no mandate and no vote behind it, and it is ONE swap of a small amount. It proves the settlement path (wrap -> 1Click live quote -> deposit -> settle -> verified balance) works; it does not prove DAO-governed cross-chain execution.',
  accounts: { funder: j!.funder, settlementAccount: j!.implicit, recipient: j!.implicit, refundTo: j!.implicit, note: 'the settlement account is an implicit account whose key the owner holds (data/secret, not published)' },
  route: { origin: ORIGIN_ASSET, destination: DEST_ASSET, swapType: 'EXACT_INPUT', amountNear: AMOUNT_NEAR, amountYocto: j!.amount },
  quote: {
    // the 1Click service signature is kept in the local journal (data/secret) and published only as a hash: an "ed25519:" string that long is what the repo's secret scan looks for
    depositAddress: q.depositAddress, correlationId: q.correlationId, timestamp: q.timestamp, signatureSha256: q.signature ? createHash('sha256').update(q.signature).digest('hex') : undefined, request: q.request,
    amountIn: q.amountIn, amountInUsd: q.amountInUsd, amountOut: q.amountOut, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut,
    withdrawFee: q.withdrawFee, refundFee: q.refundFee, timeEstimateS: q.timeEstimateS, deadline: q.deadline,
  },
  txs: j!.txs,
  oneClick: { submit: j!.submit, statusHistory: j!.status?.history, polls: j!.status?.polls, final: last, abandonedQuotes: j!.abandonedQuotes },
  balances: { before: b0, after: b1, delta: { usdc: delta(b0.usdc, b1.usdc), wnear: delta(b0.wnear, b1.wnear), near: delta(b0.near, b1.near) }, units: 'near/wnear in yocto (24 decimals), usdc in micro-USDC (6 decimals)' },
  verification: j!.verification,
  outcome: 'settled',
  source: 'chain+api',
};
mkdirSync('data/demo-run', { recursive: true });
writeFileSync(RUN_FILE, JSON.stringify(run, null, 2));
if (existsSync('app/public/demo-run')) copyFileSync(RUN_FILE, PUBLIC_RUN_FILE);
console.log(`\nSETTLED and verified: ${nearStr(BigInt(j!.amount))} wNEAR -> ${usdcStr(BigInt(run.balances.delta.usdc))} USDC received by ${j!.implicit}`);
for (const t of j!.txs) console.log(`  ${t.label}: ${t.explorer}`);
for (const t of last?.swapDetails.destinationChainTxHashes ?? []) console.log(`  1Click destination tx: ${t.explorerUrl || t.hash}`);
console.log(`wrote ${RUN_FILE}${existsSync('app/public/demo-run') ? ` and ${PUBLIC_RUN_FILE}` : ''}`);
process.exit(0);
