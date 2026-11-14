// Mainnet pre-flight: every check is a READ. Pure logic over injected readers so tests can feed fakes. No credential is ever put into a result.
import { KeyPair } from 'near-api-js';
import { isFullAccess, type Check } from './contract-verify.js';
import { SETUP_PLAN, estimateSetup, fromYocto, envFileSetsAllowMainnet, sha256Hex } from './setup-plan.js';
import type { SecretDirReport } from './secret-dir.js';

type Env = Record<string, string | undefined>;
export interface PreflightCheck extends Check { level: 'fail' | 'warn' | 'info' }
export interface PreflightDeps {
  env: Env; net: 'mainnet' | 'testnet';
  chainId(): Promise<string>;
  viewAccount(id: string): Promise<{ amount: bigint; codeHash: string } | null>;
  accessKey(id: string, publicKey: string): Promise<{ permission: unknown } | null>;
  readWasm(): Uint8Array | null;
  /** the release hash recorded when the contract was first deployed and verified (data/testnet-deploy-v2.json) */
  recordedReleaseHash(): string | null;
  codeHashOf(wasm: Uint8Array): string;
  secretDir: SecretDirReport; secretDirWritable: boolean | null;
  git: { envIgnored: boolean | null; trackedSecretLike: string[]; secretDirIgnored: boolean | null };
  envFileText: string;
  /** the minimum the setup script itself insists on (LIMITS.setupNear), in yocto */
  setupMinimum: bigint;
}

export const NAMED = /^(?!.*\.\.)[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*$/;
export const IMPLICIT = /^[0-9a-f]{64}$/;
/** Files that must never be tracked by git. */
export const secretLike = (files: string[]) => files.filter((f) => /(^|\/)\.env$/.test(f) || /(^|\/)\.env\.(?!example$|testnet\.example$)[^/]+$/.test(f) || /(^|\/)data\/secret\//.test(f) || /\.(pem|key)$/.test(f) || /(^|\/)near-credentials\//.test(f));

export async function runPreflight(d: PreflightDeps): Promise<{ checks: PreflightCheck[]; estimate: ReturnType<typeof estimateSetup> | null; wasm: { bytes: number; sha256: string; codeHash: string } | null }> {
  const checks: PreflightCheck[] = [];
  const add = (level: PreflightCheck['level'], name: string, ok: boolean, detail: string) => checks.push({ level: ok ? (level === 'info' ? 'info' : level) : level, name, ok, detail });
  const fail = (name: string, ok: boolean, detail: string) => add('fail', name, ok, detail);
  const warn = (name: string, ok: boolean, detail: string) => add('warn', name, ok, detail);
  const safe = async <T>(f: () => Promise<T>): Promise<{ v?: T; err?: string }> => { try { return { v: await f() }; } catch (e) { return { err: String((e as Error).message ?? e).slice(0, 140) }; } };

  // ---- network
  const cid = await safe(() => d.chainId());
  fail('RPC reachable and on the intended network', cid.v === d.net, cid.err ? `RPC error: ${cid.err}` : `chain_id "${cid.v}", intended "${d.net}"`);
  const onNet = cid.v === d.net;

  // ---- wasm
  const wasm = d.readWasm();
  let wasmInfo: { bytes: number; sha256: string; codeHash: string } | null = null;
  fail('WASM artifact exists', !!wasm, wasm ? `${wasm.length} bytes` : 'contracts/mandate/out/mandate.wasm is missing');
  if (wasm) {
    wasmInfo = { bytes: wasm.length, sha256: sha256Hex(wasm), codeHash: d.codeHashOf(wasm) };
    fail('WASM SHA-256 / NEAR code hash computed', true, `sha256 ${wasmInfo.sha256} | code hash ${wasmInfo.codeHash}`);
    const rec = d.recordedReleaseHash();
    if (rec) fail('WASM equals the recorded release (the one verified on testnet)', rec === wasmInfo.codeHash, `recorded ${rec} | local ${wasmInfo.codeHash}`);
    else warn('recorded release hash found', false, 'data/testnet-deploy-v2.json has no localCodeHash to compare against');
  }
  const est = wasm ? estimateSetup(wasm.length) : null;
  if (est) {
    fail('contract account funding covers the wasm storage', est.contractFundedEnough, `storage staking for ${wasm!.length} bytes = ${fromYocto(est.contractStorage)} NEAR; the contract account gets ${SETUP_PLAN.subAccounts.find((x) => x.role === 'mandate')!.near} NEAR (headroom ${fromYocto(est.contractHeadroom)})`);
  }

  // ---- environment (names and shapes only)
  const id = d.env.QT_FUNDER_ACCOUNT?.trim() ?? '', key = d.env.QT_FUNDER_KEY?.trim() ?? '';
  fail('QT_FUNDER_ACCOUNT is set', !!id, id ? 'set' : 'missing in the environment/.env');
  fail('QT_FUNDER_KEY is set', !!key, key ? 'set (value not shown)' : 'missing in the environment/.env');
  let keyOk = false, pub = '';
  if (key) {
    try { pub = KeyPair.fromString(key as any).getPublicKey().toString(); keyOk = key.startsWith('ed25519:'); } catch { keyOk = false; }
    fail('QT_FUNDER_KEY is a well-formed ed25519 secret key', keyOk, keyOk ? `derives public key ${pub}` : 'not a valid "ed25519:<base58>" secret key');
  }
  if (id) {
    const named = NAMED.test(id) && !IMPLICIT.test(id);
    fail('owner is a NAMED account (sub-accounts cannot be created under a 64-hex implicit account)', named, named ? id : `"${id}" is not a named account`);
    if (d.net === 'mainnet') warn('owner id ends with .near (a top-level mainnet name)', /\.near$/.test(id), id);
  }
  warn('NEAR_AI_API_KEY is set (needed by the end-to-end run, not by setup)', !!d.env.NEAR_AI_API_KEY?.trim(), d.env.NEAR_AI_API_KEY?.trim() ? 'set (value not shown)' : 'missing');
  fail('ALLOW_MAINNET is not stored in .env', !envFileSetsAllowMainnet(d.envFileText), envFileSetsAllowMainnet(d.envFileText) ? '.env contains ALLOW_MAINNET: remove it; consent belongs in the shell of the command' : 'consent is not stored in a file');
  fail('QT_NET does not point the scripts at the wrong network', (d.env.QT_NET ?? 'mainnet') === d.net || d.net === 'testnet', `QT_NET=${d.env.QT_NET ?? '(unset: scripts default to mainnet)'}`);

  // ---- owner on chain
  let balance: bigint | null = null;
  if (onNet && id && NAMED.test(id)) {
    const acc = await safe(() => d.viewAccount(id));
    fail('owner account exists on this network', !!acc.v, acc.v ? id : acc.err ?? `${id} not found`);
    if (acc.v) {
      balance = acc.v.amount;
      if (keyOk) {
        const ak = await safe(() => d.accessKey(id, pub));
        fail('the key belongs to the owner account and has FULL ACCESS', !!ak.v && isFullAccess(ak.v.permission), ak.v ? (isFullAccess(ak.v.permission) ? 'access key found, full access' : 'the key exists but is only a function-call key') : `${pub} is not an access key of ${id}`);
      }
      if (est) {
        const need = est.required > d.setupMinimum ? est.required : d.setupMinimum;
        fail('owner balance covers the setup', acc.v.amount >= need, `has ${fromYocto(acc.v.amount)} NEAR | needs ${fromYocto(need)} (outflow ${fromYocto(est.outflow)} = sub-accounts ${fromYocto(est.subAccounts)} + DAO ${fromYocto(est.daoDeposit)}; gas up to ${fromYocto(est.gas)}; reserve ${SETUP_PLAN.ownerReserveNear})`);
      }
    }
    // ---- targets
    for (const s of SETUP_PLAN.subAccounts) {
      const t = `${s.sub}.${id}`; const a = await safe(() => d.viewAccount(t));
      if (s.role === 'mandate') {
        const hash = a.v?.codeHash; const empty = !a.v || !hash || hash === '11111111111111111111111111111111';
        const same = !!hash && !!wasmInfo && hash === wasmInfo.codeHash;
        fail('contract account is free, or already holds exactly the committed wasm', empty || same, a.v ? (empty ? `${t} exists without code (setup will deploy)` : same ? `${t} already holds the committed wasm (setup will resume)` : `${t} holds DIFFERENT code ${hash}: setup would refuse to overwrite it`) : `${t} does not exist yet (setup creates it)`);
      } else add('info', `sub-account ${t}`, true, a.v ? 'exists (setup reuses it only if its key is in the secret directory)' : 'free');
    }
  }

  // ---- secrets and git
  const sd = d.secretDir;
  fail('secret directory is not inside a cloud-synchronised folder', !sd.synced, `${sd.resolved} (${sd.why})${sd.overridden ? ' [QT_SECRET_DIR]' : ' [default]'}`);
  if (d.secretDirWritable !== null) fail('secret directory is writable (or can be created)', d.secretDirWritable, d.secretDirWritable ? 'yes' : 'no: key files could not be saved before the first transaction');
  if (sd.insideRepo) fail('secret directory is git-ignored', d.git.secretDirIgnored === true, d.git.secretDirIgnored === true ? 'git check-ignore: ignored' : 'NOT ignored (or git unavailable)');
  else add('info', 'secret directory is outside the repository', true, 'it cannot be committed');
  fail('.env is git-ignored', d.git.envIgnored === true, d.git.envIgnored === true ? 'git check-ignore: ignored' : '.env is not ignored (or git unavailable)');
  fail('no secret-looking file is tracked by git', d.git.trackedSecretLike.length === 0, d.git.trackedSecretLike.length ? `tracked: ${d.git.trackedSecretLike.join(', ')}` : 'none');
  warn('POSIX file modes are enforced for the secret directory', process.platform !== 'win32', process.platform === 'win32' ? 'Windows: files are created with mode 0600 but it is not enforced; rely on the user-profile ACL and keep the folder out of shared locations' : 'modes 0700/0600 apply');
  return { checks, estimate: est, wasm: wasmInfo };
}
