// Worker entry. Production wiring only: real OutLayer client (configurable base URL), real chain adapter, SQLite state, HTTP API.
// Env: NEAR_NETWORK(mainnet|testnet|sandbox) DAO_ACCOUNT MANDATE_CONTRACT AGENT_ACCOUNT_ID AGENT_SECRET_KEY OUTLAYER_WK [OUTLAYER_BASE_URL]
//      SEALED_TERMS_KEY STATE_DB PORT TICK_MS WORKER_CORS_ORIGIN NEAR_AI_API_KEY (optional: /api/parse + AI summaries + the signature part of GET /attestation)
//      Public-exposure knobs (all optional): ATTESTATION=0, ATTESTATION_MODEL, REDTEAM_CACHE_S, REDTEAM_CHAIN_PER_HOUR, REDTEAM_CHAIN_PER_DAY, REDTEAM_WALLET_PER_HOUR, PARSE_PER_HOUR
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
import { KeyPair } from 'near-api-js';
import { providerFor } from '../src/near/chain';
import { validateEnv, classifyPermission, agentKeyProblems } from './config';
import { Alerts, TelegramSink } from './alerts';
import { startMonitor } from './monitor';
import { AttestationService } from './attestation';
import { RedteamGate } from './redteam';
import { WindowBudget } from './ratelimit';

// Startup guard: every configuration problem at once, before anything is touched (worker/config.ts, tests/hardening.test.ts).
const envCheck = validateEnv(process.env);
if (!envCheck.ok) { console.error(JSON.stringify({ level: 'fatal', msg: 'invalid configuration', problems: envCheck.problems })); process.exit(1); }
for (const w of envCheck.warnings) console.warn(JSON.stringify({ level: 'warn', msg: w }));
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(JSON.stringify({ level: 'fatal', msg: `missing env ${k}` })); process.exit(1); } return v; };
const rawLog = (kind: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), kind, ...fields }));
// Operator alerts (optional): ALERT_TELEGRAM_TOKEN + ALERT_TELEGRAM_CHAT. Without them alerts are logged as `alert_disabled`.
const alerts = new Alerts(process.env.ALERT_TELEGRAM_TOKEN && process.env.ALERT_TELEGRAM_CHAT ? new TelegramSink(process.env.ALERT_TELEGRAM_TOKEN, process.env.ALERT_TELEGRAM_CHAT, fetch, rawLog) : null, { log: rawLog });
const ALERT_KINDS = new Set(['wallet_blocked', 'too_many_failures', 'refused', 'prepare_error']);
const log: Logger = (kind, fields) => { rawLog(kind, fields); if (ALERT_KINDS.has(kind)) void alerts.admin(`Quiet Treasury: ${kind} ${JSON.stringify(fields).slice(0, 400)}`); };

const net = (process.env.NEAR_NETWORK ?? 'testnet') as Net;
const rpc = RPC[net];
const dao = need('DAO_ACCOUNT'), mandateContract = need('MANDATE_CONTRACT');
const agent = accountFor(rpc, need('AGENT_ACCOUNT_ID'), need('AGENT_SECRET_KEY'));
// Is the agent key as narrow as the agent needs? (a function-call key limited to the 5 agent methods; a full-access key is allowed but loudly flagged)
try {
  const pk = KeyPair.fromString(need('AGENT_SECRET_KEY') as never).getPublicKey().toString();
  const ak: any = await providerFor(rpc).viewAccessKey({ accountId: need('AGENT_ACCOUNT_ID'), publicKey: pk } as never);
  const problems = agentKeyProblems(classifyPermission(ak.permission), mandateContract);
  log(problems.length ? 'agent_key_scope_warning' : 'agent_key_scope_ok', { problems });
  if (problems.length && process.env.REQUIRE_SCOPED_KEY === '1') { console.error(JSON.stringify({ level: 'fatal', msg: 'REQUIRE_SCOPED_KEY=1 but the agent key is not scoped', problems })); process.exit(1); }
} catch (e) { log('agent_key_scope_unchecked', { message: (e as Error).message.slice(0, 120) }); }
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
  // Two credentials on purpose: AGENT_SECRET_KEY can be a function-call key limited to the mandate contract's agent methods (scripts/testnet/scoped-key.ts:
  // the NEAR protocol refuses everything else), while writing a wallet policy needs a deposit, so the wallet OWNER credential is separate (CUSTODY_OWNER_KEY).
  const ownerKey = process.env.CUSTODY_OWNER_KEY ?? need('AGENT_SECRET_KEY');
  const wallet = new OutLayerWallet({ owner: { accountId: need('AGENT_ACCOUNT_ID'), secretKey: ownerKey }, seed: need('CUSTODY_SEED') });
  const addr = await wallet.address();
  ref = new RefTestnetAdapter({
    ...refCommon, signer: new OutLayerCustodySigner(wallet, addr.address, rpc),
    policy: new MandatePolicy({ wallet, owner: accountFor(rpc, need('AGENT_ACCOUNT_ID'), ownerKey), walletId: addr.wallet_id, dex: REF_DEX, path: process.env.CUSTODY_POLICIES ?? 'data/custody-policies.json', log: refLog }),
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
const PARSE_MODEL = process.env.PARSE_MODEL ?? 'Qwen/Qwen3.8-27B'; // confidential TEE model; measured 21s/1 attempt vs glm-5.3-flash 6-170s (erratic reasoning time)
const num = (k: string, dflt: number) => { const v = Number(process.env[k]); return process.env[k] && Number.isFinite(v) && v >= 0 ? v : dflt; };
// Live attestation check (GET /attestation, summary in /health): fresh nonce + one signed completion against NEAR AI Cloud, cached 1 h, refreshed in the background.
// ATTESTATION=0 turns it off. Without NEAR_AI_API_KEY only the keyless part runs and the answer says the signature check was not run. worker/attestation.ts
const attestation = new AttestationService({
  client: new NearAiClient({ fetch: ((u: string | URL | Request, i?: RequestInit) => fetch(u, { ...i, signal: AbortSignal.timeout(45_000) })) as typeof fetch }),
  hasKey: !!process.env.NEAR_AI_API_KEY, model: process.env.ATTESTATION_MODEL ?? PARSE_MODEL, log,
});

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

// Public red-team: results cached per attack, a GLOBAL hourly budget for attacks that cost gas / touch the wallet, every answer secret-scrubbed (worker/redteam.ts).
// Env: REDTEAM_CACHE_S (600), REDTEAM_CHAIN_PER_HOUR (6), REDTEAM_CHAIN_PER_DAY (30), REDTEAM_WALLET_PER_HOUR (6); PARSE_PER_HOUR (60) caps /api/parse for all visitors together.
const redteamDeps = { chain, outlayer, termsFor: (m: Parameters<typeof termsFor>[1]) => termsFor(state, m), nowS: clock.nowS, layerA };
const api = createApi({
  state, chain, outlayer, isCouncil, nowS: clock.nowS,
  redteam: redteamDeps,
  redteamGate: new RedteamGate(redteamDeps, { cacheTtlS: num('REDTEAM_CACHE_S', 600), chainPerHour: num('REDTEAM_CHAIN_PER_HOUR', 6), chainPerDay: num('REDTEAM_CHAIN_PER_DAY', 30), walletPerHour: num('REDTEAM_WALLET_PER_HOUR', 6) }),
  parseBudget: new WindowBudget(num('PARSE_PER_HOUR', 60)),
  attestation: process.env.ATTESTATION === '0' ? undefined : () => attestation.get(),
  cfg: { dao, rpc, corsOrigin: process.env.WORKER_CORS_ORIGIN ?? '*', authRecipient: 'quiet-treasury.worker' },
  parse: ai ? async (intent) => {
    const r = await parseIntent(intent, { dao, treasurer: 'unknown.near', nowS: clock.nowS(), llm: llmFromClient(ai, PARSE_MODEL) });
    return { terms: r.terms, summary: r.summary.join('\n') };
  } : undefined,
  health: () => ({ lastTick, nowS: clock.nowS(), ticking, net, dao, mandateContract, execMode, ...(ref ? { custody: ref.custody, vault: ref.vaultId } : {}), ...(execMode === 'live-dryrun' ? { dryRun: lastDry } : {}), needsHuman: state.db.prepare("SELECT mandate_id, key, note FROM items WHERE status='needs_review'").all(), attestation: attestation.health() }),
});

const server = await api.listen(Number(process.env.PORT ?? 8787));
log('listening', { port: process.env.PORT ?? 8787, net });
if (process.env.ATTESTATION !== '0') attestation.start();
// Monitor (every 5 min; MONITOR=0 disables): stale tick, items needing a human, a mandate with no progress inside its window, a low vault. worker/monitor.ts
if (process.env.MONITOR !== '0') {
  startMonitor({
    tick: () => lastTick, tickEveryS: Number(process.env.TICK_MS ?? 5000) / 1000,
    needsReview: () => (state.db.prepare("SELECT COUNT(*) AS n FROM items WHERE status='needs_review'").get() as { n: number }).n,
    running: async () => (await chain.listMandates()).filter((m) => m.status === 'Funded' || m.status === 'Executing').map((m) => ({ id: m.id, lastProgressS: Math.max(0, ...state.chunks(m.id).map((c) => c.ts)), windowEndS: m.end_ns / 1e9 })),
    vaultNative: ref ? async () => ref!.native() : undefined,
  }, alerts, log);
}

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

