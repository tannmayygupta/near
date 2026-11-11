// Worker entry. Production wiring only: real OutLayer client (configurable base URL), real chain adapter, SQLite state, HTTP API.
// Env: NEAR_NETWORK(mainnet|testnet|sandbox) DAO_ACCOUNT MANDATE_CONTRACT AGENT_ACCOUNT_ID AGENT_SECRET_KEY OUTLAYER_WK [OUTLAYER_BASE_URL]
//      SEALED_TERMS_KEY STATE_DB PORT TICK_MS WORKER_CORS_ORIGIN NEAR_AI_API_KEY (optional: /api/parse + AI summaries)
import { RPC, accountFor, Net } from '../src/near/chain';
import { OutLayerClient, OUTLAYER_MAINNET } from '../src/near/outlayer';
import { NearAiClient } from '../src/near/ai';
import { llmFromClient, parseIntent } from '../src/engine/parser';
import { dryQuote, quoteToSample } from '../src/near/intents';
import { BOUNDS } from '../src/engine/schema';
import { Executor, defaultConfig } from './executor';
import { RealChain } from './chain';
import { State, loadKey } from './state';
import { createApi } from './api';
import { termsFor } from './api';
import type { Clock, Logger } from './ports';

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(JSON.stringify({ level: 'fatal', msg: `missing env ${k}` })); process.exit(1); } return v; };
const log: Logger = (kind, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), kind, ...fields }));

const net = (process.env.NEAR_NETWORK ?? 'testnet') as Net;
const rpc = RPC[net];
const dao = need('DAO_ACCOUNT'), mandateContract = need('MANDATE_CONTRACT');
const agent = accountFor(rpc, need('AGENT_ACCOUNT_ID'), need('AGENT_SECRET_KEY'));
const outlayer = new OutLayerClient({ baseUrl: process.env.OUTLAYER_BASE_URL ?? OUTLAYER_MAINNET, apiKey: need('OUTLAYER_WK') });
const state = new State(process.env.STATE_DB ?? 'data/worker.sqlite', loadKey());
const chain = new RealChain({ rpc, mandateContract, dao, agent });
const clock: Clock = { nowS: () => Math.floor(Date.now() / 1000), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

let lastTick = 0, ticking = false;
const ai = process.env.NEAR_AI_API_KEY ? new NearAiClient() : null;

const exec = new Executor({
  outlayer, chain, state, clock, log,
  benchmark: async (terms, nowS) => quoteToSample(await dryQuote({
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

const api = createApi({
  state, chain, outlayer, isCouncil, nowS: clock.nowS,
  redteam: { chain, outlayer, termsFor: (m) => termsFor(state, m), nowS: clock.nowS },
  cfg: { dao, rpc, corsOrigin: process.env.WORKER_CORS_ORIGIN ?? '*', authRecipient: 'quiet-treasury.worker' },
  parse: ai ? async (intent) => {
    const r = await parseIntent(intent, { dao, treasurer: 'unknown.near', nowS: clock.nowS(), llm: llmFromClient(ai) });
    return { terms: r.terms, summary: r.summary.join('\n') };
  } : undefined,
  health: () => ({ lastTick, ticking, net, dao, mandateContract, needsHuman: state.db.prepare("SELECT mandate_id, key, note FROM items WHERE status='needs_review'").all() }),
});

const server = await api.listen(Number(process.env.PORT ?? 8787));
log('listening', { port: process.env.PORT ?? 8787, net });

let stop = false;
const tickMs = Number(process.env.TICK_MS ?? 5000);
(async () => {
  while (!stop) {
    ticking = true;
    try { await exec.tick(); lastTick = clock.nowS(); } catch (e) { log('tick_error', { message: (e as Error).message }); }
    ticking = false;
    await clock.sleep(tickMs);
  }
})();

const shutdown = () => { log('shutdown', {}); stop = true; server.close(); setTimeout(() => { state.close(); process.exit(0); }, 500); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
