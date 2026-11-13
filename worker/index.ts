// Worker entry. Production wiring only: real OutLayer client (configurable base URL), real chain adapter, SQLite state, HTTP API.
// Env: NEAR_NETWORK(mainnet|testnet|sandbox) DAO_ACCOUNT MANDATE_CONTRACT AGENT_ACCOUNT_ID AGENT_SECRET_KEY OUTLAYER_WK [OUTLAYER_BASE_URL]
//      SEALED_TERMS_KEY STATE_DB PORT TICK_MS WORKER_CORS_ORIGIN NEAR_AI_API_KEY (optional: /api/parse + AI summaries)
import { RPC, accountFor, Net } from '../src/near/chain';
import { OutLayerClient, OUTLAYER_MAINNET } from '../src/near/outlayer';
import { SimulatedOutLayer } from './adapters/simulated-outlayer';
import { RefTestnetAdapter, REF_DEX } from './adapters/ref-testnet';
import { OutLayerCustodySigner } from './adapters/signers';
import { MandatePolicy } from './adapters/mandate-policy';
import { LiveDryRunOutLayer, dryRunDecision } from './adapters/live-dryrun';
import { createSummarizer } from './summarizer';
import { OutLayerWallet, layerAVerdict } from '../src/near/outlayer-policy';
import { NearAiClient } from '../src/near/ai';
import { llmFromClient, parseIntent } from '../src/engine/parser';
import { dryQuote, quoteToSample } from '../src/near/intents';
import { BOUNDS, MAINNET_TOKENS } from '../src/engine/schema';
import { Executor, defaultConfig } from './executor';
import { RealChain } from './chain';
import { State, loadKey } from './state';
import { createApi } from './api';
import { termsFor } from './api';
import type { Clock, Logger, OutLayerPort } from './ports';

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(JSON.stringify({ level: 'fatal', msg: `missing env ${k}` })); process.exit(1); } return v; };
const log: Logger = (kind, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), kind, ...fields }));

const net = (process.env.NEAR_NETWORK ?? 'testnet') as Net;
const rpc = RPC[net];
const dao = need('DAO_ACCOUNT'), mandateContract = need('MANDATE_CONTRACT');
const agent = accountFor(rpc, need('AGENT_ACCOUNT_ID'), need('AGENT_SECRET_KEY'));
// EXEC_MODE: 'live' (default; the real OutLayer client, UNPROVEN with real money) | 'simulated' (testnet adapter; fills are priced from real 1Click dry quotes and are NOT trades)
const execMode = process.env.EXEC_MODE ?? 'live';
// 'testnet-real': REAL on-chain testnet execution through Ref Finance (swap, payout, return are real txs; custody = a vault key held by the worker; see worker/adapters/ref-testnet.ts)
// 'testnet-outlayer': the same real execution, but the vault is an OutLayer agent wallet (key in OutLayer's TEE): every call is signed by OutLayer under a wallet policy
// the worker writes per mandate before it trades (Layer A). Env: AGENT_ACCOUNT_ID/AGENT_SECRET_KEY (the wallet OWNER), CUSTODY_SEED, optional CUSTODY_POLICIES.
const refLog = (k: string, f: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), kind: `ref_${k}`, ...f }));
const refCommon = {
  rpc, ledgerPath: process.env.REF_LEDGER ?? 'data/ref-ledger.json', log: refLog,
  reserveYocto: BigInt(process.env.VAULT_RESERVE_YOCTO ?? '2000000000000000000000000'),
  refPrice: async () => { try { const [w, u] = Object.keys(MAINNET_TOKENS); const q = await dryQuote({ originAsset: w, destinationAsset: u, amount: (10n ** 23n).toString(), recipient: need('SIM_QUOTE_RECIPIENT'), refundTo: need('SIM_QUOTE_RECIPIENT') }); return (Number(BigInt(q.amountOut)) / 1e6) / 0.1; } catch { return null; } },
};
let ref: RefTestnetAdapter | null = null;
if (execMode === 'testnet-real') ref = new RefTestnetAdapter({ ...refCommon, vault: accountFor(rpc, need('VAULT_ACCOUNT_ID'), need('VAULT_SECRET_KEY')) });
else if (execMode === 'testnet-outlayer') {
  const wallet = new OutLayerWallet({ owner: { accountId: need('AGENT_ACCOUNT_ID'), secretKey: need('AGENT_SECRET_KEY') }, seed: need('CUSTODY_SEED') });
  const addr = await wallet.address();
  ref = new RefTestnetAdapter({
    ...refCommon, signer: new OutLayerCustodySigner(wallet, addr.address, rpc),
    policy: new MandatePolicy({ wallet, owner: agent, walletId: addr.wallet_id, dex: REF_DEX, path: process.env.CUSTODY_POLICIES ?? 'data/custody-policies.json', log: refLog }),
  });
  console.log(JSON.stringify({ level: 'info', msg: 'EXEC_MODE=testnet-outlayer: vault is an OutLayer custody wallet', wallet: addr.address }));
}
// 'live-dryrun': the live Intents/OutLayer DECISION path (real 1Click dry quotes + planner + price floor) with every money-moving call blocked and no chain writes; see worker/adapters/live-dryrun.ts
const outlayer: OutLayerPort = ref ? ref : execMode === 'live-dryrun'
  ? new LiveDryRunOutLayer({ recipient: process.env.DRYRUN_RECIPIENT ?? '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88' })
  : execMode === 'simulated'
  ? new SimulatedOutLayer({ recipient: need('SIM_QUOTE_RECIPIENT') })
  : new OutLayerClient({ baseUrl: process.env.OUTLAYER_BASE_URL ?? OUTLAYER_MAINNET, apiKey: need('OUTLAYER_WK') });
if (execMode === 'simulated') console.warn(JSON.stringify({ level: 'warn', msg: 'EXEC_MODE=simulated: fills are SIMULATED and tagged so; this is not real trading' }));
const state = new State(process.env.STATE_DB ?? 'data/worker.sqlite', loadKey());
const chain = new RealChain({ rpc, mandateContract, dao, agent });
const clock: Clock = { nowS: () => Math.floor(Date.now() / 1000), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

let lastTick = 0, ticking = false;
const lastDry: Record<number, unknown> = {}; // live-dryrun: latest decision per mandate (also served in /health)
const ai = process.env.NEAR_AI_API_KEY ? new NearAiClient() : null;

const exec = new Executor({
  outlayer, chain, state, clock, log, summarize: ai ? createSummarizer(ai) : undefined,
  prepare: ref ? (m, terms) => ref!.prepareMandate(m.id, terms) : undefined, // OutLayer custody: write this mandate's wallet policy before it trades (no-op for the key vault)
  poolSnapshot: ref ? async (terms) => { const s = await ref.poolSnapshot(terms.sellToken, terms.buyToken, BigInt(terms.chunkMax)); return s ? { poolId: s.poolId, reserveIn: s.reserveIn, reserveOut: s.reserveOut, feeBps: s.feeBps, ts: s.ts } : null; } : undefined,
  benchmark: ref ? (terms) => ref.spotSample(terms.sellToken, terms.buyToken, BOUNDS.allowedTokens[terms.sellToken].decimals, BOUNDS.allowedTokens[terms.buyToken].decimals)
    : async (terms, nowS) => quoteToSample(await dryQuote({
    originAsset: terms.sellToken, destinationAsset: terms.buyToken,
    amount: (10n ** BigInt(BOUNDS.allowedTokens[terms.sellToken].decimals - 1)).toString(), // 0.1 sell-token reference quote
    recipient: terms.returnTo, refundTo: terms.returnTo, nowS: () => nowS,
  }), terms.sellToken, terms.buyToken),
}, defaultConfig(dao));

let councilCache: { at: number; set: Set<string> } = { at: 0, set: new Set() };
async function isCouncil(account: string) {
  if (Date.now() - councilCache.at > 60_000) {
    const p = await chain.viewRaw<any>(dao, 'get_policy');
    const g = (p.roles ?? []).flatMap((r: any) => r.kind?.Group ?? []); councilCache = { at: Date.now(), set: new Set(g) };
  }
  return councilCache.set.has(account);
}

// Layer A (OutLayer wallet policy) probe for the red-team page: configured only when an owner key + seed are provided (testnet wallet, native transfers)
const layerA = process.env.LAYER_A_SEED && process.env.LAYER_A_OWNER_ACCOUNT && process.env.LAYER_A_OWNER_KEY && process.env.LAYER_A_ALLOWED
  ? (() => { const w = new OutLayerWallet({ owner: { accountId: process.env.LAYER_A_OWNER_ACCOUNT!, secretKey: process.env.LAYER_A_OWNER_KEY! }, seed: process.env.LAYER_A_SEED! });
      return { transfer: (b: { to: string; amount: string }) => w.transfer(b), verdict: layerAVerdict, unlistedTo: 'attacker-unlisted.testnet', allowedTo: process.env.LAYER_A_ALLOWED!, smallAmount: '10000000000000000000000', overCapAmount: '500000000000000000000000' }; })()
  : undefined;

const api = createApi({
  state, chain, outlayer, isCouncil, nowS: clock.nowS,
  redteam: { chain, outlayer, termsFor: (m) => termsFor(state, m), nowS: clock.nowS, layerA },
  cfg: { dao, rpc, corsOrigin: process.env.WORKER_CORS_ORIGIN ?? '*', authRecipient: 'quiet-treasury.worker' },
  parse: ai ? async (intent) => {
    const r = await parseIntent(intent, { dao, treasurer: 'unknown.near', nowS: clock.nowS(), llm: llmFromClient(ai, process.env.PARSE_MODEL ?? 'Qwen/Qwen3.8-27B') }); // confidential TEE model; measured 21s/1 attempt vs glm-5.3-flash 6-170s (erratic reasoning time)
    return { terms: r.terms, summary: r.summary.join('\n') };
  } : undefined,
  health: () => ({ lastTick, ticking, net, dao, mandateContract, execMode, ...(ref ? { custody: ref.custody, vault: ref.vaultId } : {}), ...(execMode === 'live-dryrun' ? { dryRun: lastDry } : {}), needsHuman: state.db.prepare("SELECT mandate_id, key, note FROM items WHERE status='needs_review'").all() }),
});

const server = await api.listen(Number(process.env.PORT ?? 8787));
log('listening', { port: process.env.PORT ?? 8787, net });

// near.social publishing (FastData KV): SOCIAL_PUBLISH=1 SOCIAL_ACCOUNT_ID / SOCIAL_ACCOUNT_KEY (default: the agent account)
let social: import('./social-publisher').SocialPublisher | undefined;
if (process.env.SOCIAL_PUBLISH === '1') {
  const { SocialPublisher, nearblocksAnchorFinder } = await import('./social-publisher');
  const { senderFor } = await import('../src/near/social');
  const { providerFor } = await import('../src/near/chain');
  const acct = process.env.SOCIAL_ACCOUNT_ID ? accountFor(rpc, process.env.SOCIAL_ACCOUNT_ID, need('SOCIAL_ACCOUNT_KEY')) : agent;
  const prov = providerFor(rpc);
  social = new SocialPublisher({
    net: net === 'mainnet' ? 'mainnet' : 'testnet', account: acct.accountId, dao, contract: mandateContract, chain, send: senderFor(acct), db: state.db, log,
    explorerAccount: (a) => (net === 'mainnet' ? `https://nearblocks.io/address/${a}` : `https://explorer.testnet.near.org/accounts/${a}`),
    findAnchorTx: nearblocksAnchorFinder({
      api: net === 'mainnet' ? 'https://api.nearblocks.io' : 'https://api-testnet.nearblocks.io', rpc, contract: mandateContract,
      decode: async (h, signer) => { const o: any = await prov.viewTransactionStatus({ txHash: h, accountId: signer, waitUntil: 'EXECUTED' } as any); const fc = o.transaction?.actions?.[0]?.FunctionCall; return fc ? { args: JSON.parse(Buffer.from(fc.args, 'base64').toString()) } : null; },
    }),
  });
}

// live-dryrun tick: decide what the live executor WOULD do for each approved mandate; sends nothing, writes nothing on chain
async function dryRunTick() {
  const ad = outlayer as LiveDryRunOutLayer;
  for (const m of await chain.listMandates()) {
    if (!['Approved', 'Funded', 'Executing'].includes(m.status)) continue;
    const terms = await termsFor(state, m);
    if (!terms) { log('dryrun_skip', { mandate: m.id, reason: 'terms unavailable (sealed and not delivered?)' }); continue; }
    const d = await dryRunDecision(terms, { adapter: ad, nowS: clock.nowS(), remaining: BigInt(m.max_sell) - BigInt(m.sold), idem: `${m.id}:${m.chunks}` });
    lastDry[m.id] = { at: clock.nowS(), ...d, plan: { ...d.plan, size: 'size' in d.plan ? d.plan.size.toString() : undefined } };
    log('dryrun_decision', { mandate: m.id, note: d.note, floorOk: d.floorOk, minAmountOut: d.minAmountOut, quotedOut: d.quote?.amount_out, wouldSend: d.wouldSend });
  }
}

let stop = false;
const tickMs = Number(process.env.TICK_MS ?? 5000);
(async () => {
  while (!stop) {
    ticking = true;
    try {
      if (execMode === 'simulated' && process.env.SIM_AUTOFUND === '1') { // demo stand-in for the DAO->agent funding transfer (mainnet-only, unproven)
        const sim = outlayer as SimulatedOutLayer;
        for (const mm of await chain.listMandates()) if (mm.status === 'Approved' && !(sim as any)._funded?.has(mm.id)) { ((sim as any)._funded ??= new Set()).add(mm.id); sim.fund(mm.sell_token, BigInt(mm.max_sell)); log('simulated_funding', { mandate: mm.id }); }
      }
      if (execMode === 'live-dryrun') await dryRunTick(); else await exec.tick();
      lastTick = clock.nowS();
      if (social) await social.tick().catch((e) => log('social_error', { message: (e as Error).message }));
    } catch (e) { log('tick_error', { message: (e as Error).message }); }
    ticking = false;
    await clock.sleep(tickMs);
  }
})();

const shutdown = () => { log('shutdown', {}); stop = true; server.close(); setTimeout(() => { state.close(); process.exit(0); }, 500); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

