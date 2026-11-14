// The order of operations of ONE real NEAR Intents settlement (owner-run, own accounts, mainnet): fund a fresh implicit account, wrap NEAR, get a live
// 1Click quote, deposit the wNEAR to the quote's deposit address, wait for 1Click, verify the USDC arrived.
//
// This file contains no network and no key: every chain and 1Click call goes through the injected `SettlePort`, so the ordering and the safety rules are
// unit-tested with fakes (tests/intents-live.test.ts). scripts/mainnet/intents-settle.ts supplies the real port.
//
// Safety rules enforced here (AGENTS.md: idempotency first, an unknown outcome is parked, not guessed):
//  - every step first looks at on-chain state and skips itself when it is already done (a re-run never funds, wraps or registers twice);
//  - the deposit is the point of no return: the intent is written to the journal BEFORE the transfer, the tx hash right after, and a journal that holds
//    an attempt without a result is PARKED: the deposit is never sent again by this code;
//  - a deposit whose outcome cannot be established (timeout, polling error, failed transfer call) ends as outcome 'unknown' with the deposit address
//    and tx hash printed by the caller, never as a guess;
//  - success is only declared when the USDC balance of the recipient rose by at least the quote's minAmountOut.
import { LiveGuardError, assertQuoteSane, quoteValidUntilS, type LiveQuote, type LiveQuoteInput, type StatusRecord, type WaitResult } from './intents-live';
import { MAINNET_ASSETS, validateAddress } from './routes';

export const WRAP = 'wrap.near';
export const USDC = MAINNET_ASSETS.USDC.near.replace(/^nep141:/, '');
export const ORIGIN_ASSET = MAINNET_ASSETS.wNEAR.id;
export const DEST_ASSET = MAINNET_ASSETS.USDC.near;
/** NEAR the implicit account receives on top of the swap amount: storage registrations (3 x 0.00125), account storage and gas, with a wide margin. Leftover stays on the implicit account. */
export const GAS_FLOAT = 60n * 10n ** 21n; // 0.06 NEAR
/** Below this NEAR balance (on top of what is still to be wrapped) a re-run tops the float up to GAS_FLOAT again. */
export const MIN_FLOAT = 3n * 10n ** 22n; // 0.03 NEAR
/** NEAR the funder must keep after funding (so a transfer can never empty the owner's account). */
export const FUNDER_RESERVE = 10n ** 22n; // 0.01 NEAR
export const explorerTx = (h: string) => `https://nearblocks.io/txns/${h}`;

export interface TxRef { label: string; txHash: string; explorer: string }
export interface Balances { near: string; wnear: string; usdc: string }

export interface Journal {
  version: 1; startedAt: string; implicit: string; funder: string; amount: string;
  txs: TxRef[];
  balancesBefore?: Balances; balancesAfter?: Balances;
  /** quotes abandoned before any deposit (expired): the deposit addresses stay empty */
  abandonedQuotes: Array<{ depositAddress: string; correlationId: string }>;
  quote?: LiveQuote;
  /** written BEFORE the deposit is sent; present without `deposit` = outcome unknown = parked */
  depositAttempt?: { atS: number; depositAddress: string; amount: string };
  deposit?: { txHash: string; atS: number; recoveredManually?: boolean };
  submit?: { ok: boolean; error?: string };
  status?: { final: WaitResult['status']; history: WaitResult['history']; polls: number; transient: string[]; last?: StatusRecord };
  verification?: { deltaUsdc: string; minAmountOut: string; ok: boolean };
  outcome?: Outcome; outcomeNote?: string; finishedAt?: string;
}
export type Outcome = 'settled' | 'refunded' | 'failed' | 'unknown' | 'verification_failed';

export interface SettlePort {
  nowS(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /** yoctoNEAR balance, or null when the account does not exist */
  nearBalance(account: string): Promise<bigint | null>;
  ftBalance(token: string, account: string): Promise<bigint>;
  storageRegistered(token: string, account: string): Promise<boolean>;
  storageMin(token: string): Promise<bigint>;
  /** signed by the FUNDER; returns the tx hash; throws if the tx failed */
  transferNear(to: string, amount: bigint): Promise<string>;
  /** signed by the implicit account, pays `amount` yoctoNEAR; registers `forAccount` on `token` (registration_only) */
  storageDeposit(token: string, forAccount: string, amount: bigint): Promise<string>;
  /** signed by the implicit account: wrap.near near_deposit with `amount` attached */
  nearDeposit(amount: bigint): Promise<string>;
  /** signed by the implicit account: ft_transfer with 1 yoctoNEAR */
  ftTransfer(token: string, to: string, amount: bigint): Promise<string>;
  liveQuote(input: Pick<LiveQuoteInput, 'originAsset' | 'destinationAsset' | 'amount' | 'recipient' | 'refundTo' | 'slippageBps' | 'deadlineS'>): Promise<LiveQuote>;
  submitDeposit(input: { txHash: string; depositAddress: string; nearSenderAccount: string }): Promise<StatusRecord>;
  waitForStatus(input: { depositAddress: string; timeoutMs: number; pollMs: number }): Promise<WaitResult>;
  loadJournal(): Journal | undefined;
  saveJournal(j: Journal): void;
}

export interface SettleConfig {
  implicit: string; funder: string;
  /** yoctoNEAR of wNEAR to swap (already checked against the spend cap by the caller) */
  amount: bigint;
  slippageBps?: number; deadlineS?: number; maxLossBps?: number;
  statusTimeoutMs?: number; pollMs?: number; verifyTimeoutMs?: number;
  /** only for a parked journal: the deposit tx hash the owner found on the explorer, so the run can continue polling instead of staying parked */
  recoveredDepositTx?: string;
}

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const fmt = (y: bigint, d: number, shown = 6) => { const s = y.toString().padStart(d + 1, '0'); return `${s.slice(0, -d)}.${s.slice(-d).slice(0, shown)}`; };

/** Run (or resume) one settlement. Resolves with the journal (outcome set) for every post-deposit ending; throws for anything that happens BEFORE a deposit. */
export async function runSettlement(port: SettlePort, cfg: SettleConfig): Promise<Journal> {
  const nowS = () => port.nowS();
  if (validateAddress('near', cfg.implicit) || !/^[0-9a-f]{64}$/.test(cfg.implicit)) throw new LiveGuardError('the settlement account must be a lowercase 64-hex implicit account');
  if (cfg.amount <= 0n) throw new LiveGuardError('amount must be positive');

  const existing = port.loadJournal();
  if (existing && (existing.implicit !== cfg.implicit || existing.amount !== cfg.amount.toString())) {
    throw new LiveGuardError('the journal in data/secret belongs to a different run (other account or amount). Check it, then move it away on purpose; nothing was sent.');
  }
  const j: Journal = existing ?? { version: 1, startedAt: new Date(nowS() * 1000).toISOString(), implicit: cfg.implicit, funder: cfg.funder, amount: cfg.amount.toString(), txs: [], abandonedQuotes: [] };
  const save = () => port.saveJournal(j);
  const send = async (label: string, fn: () => Promise<string>) => {
    const txHash = await fn();
    j.txs.push({ label, txHash, explorer: explorerTx(txHash) });
    save(); port.log(`  tx ${label}: ${explorerTx(txHash)}`);
    return txHash;
  };
  /** re-read chain state until `ok` (receipts of the previous tx may land a block later); fail closed if it never does */
  const until = async (what: string, ok: () => Promise<boolean>) => {
    for (let i = 0; i < 20; i++) { if (await ok()) return; await port.sleep(1500); }
    throw new Error(`after the transaction, "${what}" was never visible on chain; stopping before anything further is sent`);
  };
  const A = cfg.implicit;
  save();

  // ---- a deposit attempt without a recorded result: PARKED, never repeated
  if (j.depositAttempt && !j.deposit) {
    if (cfg.recoveredDepositTx) {
      if (!TX_HASH.test(cfg.recoveredDepositTx)) throw new LiveGuardError('INTENTS_DEPOSIT_TX is not a transaction hash');
      j.deposit = { txHash: cfg.recoveredDepositTx, atS: nowS(), recoveredManually: true }; save();
      port.log('parked deposit: continuing with the transaction hash you supplied (the deposit is NOT sent again)');
    } else {
      j.outcome = 'unknown';
      j.outcomeNote = `an earlier run tried to deposit to ${j.depositAttempt.depositAddress} and its result was never recorded. The deposit is NOT sent again. Look at https://nearblocks.io/address/${A} for the ft_transfer; if you find it, re-run with INTENTS_DEPOSIT_TX=<hash>; if it is not there, the funds are still in ${A}.`;
      save(); return j;
    }
  }

  if (!j.deposit) {
    // ---- 1. fund the implicit account. Balance-based, and aware of work already done: NEAR that was already wrapped is not funded a second time
    //         (a re-run after the wrap sees a NEAR balance of about the float, not amount + float, and must NOT top it up by the amount again).
    const held = await port.ftBalance(WRAP, A);
    const toWrap = held >= cfg.amount ? 0n : cfg.amount - held;
    const need = toWrap + MIN_FLOAT;
    const have = (await port.nearBalance(A)) ?? 0n;
    if (have < need) {
      const top = toWrap + GAS_FLOAT - have;
      const fb = await port.nearBalance(cfg.funder);
      if (fb === null) throw new LiveGuardError(`funder account ${cfg.funder} does not exist on this network`);
      if (fb < top + FUNDER_RESERVE) throw new LiveGuardError(`funder holds ${fmt(fb, 24, 4)} NEAR; needs ${fmt(top + FUNDER_RESERVE, 24, 4)} (${fmt(top, 24, 4)} to send + 0.01 reserve)`);
      port.log(`1. fund ${A.slice(0, 8)}... with ${fmt(top, 24, 4)} NEAR (swap ${fmt(cfg.amount, 24, 4)} + 0.06 float)`);
      await send('fund the implicit account from the funder', () => port.transferNear(A, top));
      await until('implicit account balance', async () => ((await port.nearBalance(A)) ?? 0n) >= need);
    } else port.log('1. implicit account already holds enough for the remaining steps: skipped');

    // ---- 2. register the implicit account on wrap.near (a NEP-141 receiver must be registered)
    if (!(await port.storageRegistered(WRAP, A))) {
      port.log('2. register the implicit account on wrap.near');
      await send('register on wrap.near', async () => port.storageDeposit(WRAP, A, await port.storageMin(WRAP)));
      await until('wrap.near registration', () => port.storageRegistered(WRAP, A));
    } else port.log('2. already registered on wrap.near: skipped');

    // ---- 3. wrap NEAR -> wNEAR
    const wn = await port.ftBalance(WRAP, A);
    if (wn < cfg.amount) {
      const wrapAmt = cfg.amount - wn;
      port.log(`3. wrap ${fmt(wrapAmt, 24, 4)} NEAR`);
      await send('wrap NEAR (wrap.near near_deposit)', () => port.nearDeposit(wrapAmt));
      await until('wNEAR balance', async () => (await port.ftBalance(WRAP, A)) >= cfg.amount);
    } else port.log('3. wNEAR already held: skipped');

    // ---- 4. register the recipient (= the same implicit account) on USDC so the output has somewhere to land
    if (!(await port.storageRegistered(USDC, A))) {
      port.log('4. register the implicit account on the USDC contract');
      await send('register on USDC', async () => port.storageDeposit(USDC, A, await port.storageMin(USDC)));
      await until('USDC registration', () => port.storageRegistered(USDC, A));
    } else port.log('4. already registered on USDC: skipped');

    // ---- 5. balances before (recorded once; a resume keeps the first reading)
    if (!j.balancesBefore) {
      j.balancesBefore = { near: String((await port.nearBalance(A)) ?? 0n), wnear: String(await port.ftBalance(WRAP, A)), usdc: String(await port.ftBalance(USDC, A)) };
      save();
    }
    if (BigInt(await port.ftBalance(WRAP, A)) < cfg.amount) throw new LiveGuardError('wNEAR balance is below the swap amount: stopping before the quote');

    // ---- 6. live quote (reuse the journaled one while it still has time; an expired one is abandoned, never deposited to)
    const minRemainingS = 300;
    const stale = j.quote && quoteValidUntilS(j.quote) - nowS() < minRemainingS;
    if (j.quote && stale) { j.abandonedQuotes.push({ depositAddress: j.quote.depositAddress, correlationId: j.quote.correlationId }); j.quote = undefined; save(); }
    if (!j.quote) {
      port.log('6. request a live 1Click quote (dry:false)');
      const q = await port.liveQuote({ originAsset: ORIGIN_ASSET, destinationAsset: DEST_ASSET, amount: cfg.amount.toString(), recipient: A, refundTo: A, slippageBps: cfg.slippageBps ?? 100, deadlineS: cfg.deadlineS ?? 1200 });
      if (validateAddress('near', q.depositAddress)) throw new LiveGuardError(`deposit address "${q.depositAddress}" is not a valid NEAR account id: refusing`);
      assertQuoteSane(q, { nowS: nowS(), minRemainingS, maxLossBps: cfg.maxLossBps });
      j.quote = q; save();
    } else port.log('6. reusing the journaled quote');
    const q = j.quote!;
    port.log(`   quote: in ${fmt(BigInt(q.amountIn), 24, 4)} wNEAR -> out ${fmt(BigInt(q.amountOut), 6)} USDC (min ${fmt(BigInt(q.minAmountOut), 6)}), deposit address ${q.depositAddress}, deadline ${q.deadline}`);

    // ---- 7. register the deposit address on wrap.near (ft_transfer to an unregistered account panics; this costs 0.00125 NEAR from the implicit account)
    if (!(await port.storageRegistered(WRAP, q.depositAddress))) {
      port.log('7. register the deposit address on wrap.near');
      await send('register the deposit address on wrap.near', async () => port.storageDeposit(WRAP, q.depositAddress, await port.storageMin(WRAP)));
      await until('deposit address registration', () => port.storageRegistered(WRAP, q.depositAddress));
    } else port.log('7. deposit address already registered on wrap.near: skipped');

    // ---- 8. THE DEPOSIT: the point of no return
    assertQuoteSane(q, { nowS: nowS(), minRemainingS: 120, maxLossBps: cfg.maxLossBps }); // still valid a moment before sending
    if (BigInt(await port.ftBalance(WRAP, A)) < cfg.amount) throw new LiveGuardError('wNEAR balance is below the swap amount: stopping before the deposit');
    j.depositAttempt = { atS: nowS(), depositAddress: q.depositAddress, amount: cfg.amount.toString() }; save();
    port.log(`8. DEPOSIT ${fmt(cfg.amount, 24, 4)} wNEAR to ${q.depositAddress}`);
    try {
      const txHash = await port.ftTransfer(WRAP, q.depositAddress, cfg.amount);
      j.deposit = { txHash, atS: nowS() };
      j.txs.push({ label: 'DEPOSIT: wNEAR ft_transfer to the 1Click deposit address', txHash, explorer: explorerTx(txHash) });
      save(); port.log(`  tx deposit: ${explorerTx(txHash)}`);
    } catch (e) {
      // Whether the transfer landed is unknown (it may have been included even though the call threw). Park it; do not retry.
      j.outcome = 'unknown';
      j.outcomeNote = `the deposit call threw: ${(e as Error).message.slice(0, 300)}. It may or may not have landed. It is NOT sent again. Check https://nearblocks.io/address/${A} and the status of ${q.depositAddress}.`;
      save(); return j;
    }
  } else port.log('a deposit is already recorded in the journal: not depositing again, going straight to the status');

  // ---- 9..11 from here on the deposit exists: nothing below may ever send it again
  const q = j.quote;
  if (!q) { j.outcome = 'unknown'; j.outcomeNote = 'a deposit is recorded but the journal has no quote'; save(); return j; }
  const finish = (outcome: Outcome, note?: string) => { j.outcome = outcome; j.outcomeNote = note; j.finishedAt = new Date(nowS() * 1000).toISOString(); save(); return j; };
  try {
    if (!j.submit) {
      try { await port.submitDeposit({ txHash: j.deposit!.txHash, depositAddress: q.depositAddress, nearSenderAccount: A }); j.submit = { ok: true }; }
      catch (e) { j.submit = { ok: false, error: (e as Error).message.slice(0, 300) }; port.log(`  deposit/submit failed (non-fatal, 1Click also detects deposits by itself): ${j.submit.error}`); }
      save();
    }
    port.log('9. waiting for 1Click to settle (polling /v0/status)');
    const w = await port.waitForStatus({ depositAddress: q.depositAddress, timeoutMs: cfg.statusTimeoutMs ?? 600_000, pollMs: cfg.pollMs ?? 3000 });
    j.status = { final: w.status, history: w.history, polls: w.polls, transient: w.transient, last: w.last }; save();
    if (w.status === 'TIMEOUT') return finish('unknown', `1Click did not reach a final status in time (last: ${w.last?.status ?? 'none'}). The deposit tx ${j.deposit!.txHash} is on chain; the swap may still complete or refund to ${A}.`);
    if (w.status === 'FAILED') return finish('failed', `1Click reported FAILED. The wNEAR left ${A} in tx ${j.deposit!.txHash}; where it is now is unknown: ask 1Click support with correlationId ${q.correlationId}.`);
    if (w.status === 'REFUNDED') return finish('refunded', `1Click refunded the deposit${w.last?.swapDetails.refundReason ? ` (${w.last.swapDetails.refundReason})` : ''}; the wNEAR returns to ${A}. No swap happened.`);

    // ---- 10. SUCCESS reported: verify on chain that the recipient really holds more USDC
    const before = BigInt(j.balancesBefore?.usdc ?? '0'), min = BigInt(q.minAmountOut);
    const deadline = port.nowS() + Math.ceil((cfg.verifyTimeoutMs ?? 60_000) / 1000);
    let after = await port.ftBalance(USDC, A);
    while (after - before < min && port.nowS() < deadline) { await port.sleep(3000); after = await port.ftBalance(USDC, A); }
    const delta = after - before;
    j.balancesAfter = { near: String((await port.nearBalance(A)) ?? 0n), wnear: String(await port.ftBalance(WRAP, A)), usdc: String(after) };
    j.verification = { deltaUsdc: delta.toString(), minAmountOut: q.minAmountOut, ok: delta >= min };
    if (delta < min) return finish('verification_failed', `1Click said SUCCESS but the USDC balance of ${A} rose by ${delta} (quote minimum ${min}). Not claiming a settlement. Check the destination tx hashes.`);
    return finish('settled');
  } catch (e) {
    return finish('unknown', `deposit sent in tx ${j.deposit!.txHash}, then: ${(e as Error).message.slice(0, 300)}. The deposit is NOT sent again.`);
  }
}
