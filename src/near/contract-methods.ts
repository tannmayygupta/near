// One authoritative inventory of the mandate contract's public methods, derived from the source AND from the compiled wasm (export section),
// so a doc, a test or a script can never disagree with what is deployed.
export type Kind = 'init' | 'dao' | 'agent' | 'proposed-dao' | 'view' | 'metadata' | 'feature-gated';
export interface Method { name: string; kind: Kind; mutates: boolean; guard: string | null }

/** Exported function names of a wasm binary (LEB128 walk of the export section). Memory/table/global exports are skipped. */
export function wasmFunctionExports(wasm: Uint8Array): string[] {
  let p = 8; // magic + version
  const leb = () => { let r = 0, s = 0, b: number; do { b = wasm[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const out: string[] = [];
  while (p < wasm.length) {
    const id = wasm[p++], size = leb(), end = p + size;
    if (id === 7) {
      const n = leb();
      for (let i = 0; i < n; i++) {
        const len = leb(); const name = Buffer.from(wasm.slice(p, p + len)).toString('utf8'); p += len;
        const kind = wasm[p++]; leb(); // kind 0 = function
        if (kind === 0) out.push(name);
      }
      return out.sort();
    }
    p = end;
  }
  return out;
}

/** `pub fn` names inside `#[near] impl Contract` blocks, with the guard each one calls (assert_dao / assert_agent / pending check). Feature-gated modules are reported separately. */
export function sourceMethods(src: string): Method[] {
  const gated = new Set<string>();
  const mig = src.indexOf('#[cfg(feature = "migrate")]');
  const mainPart = mig >= 0 ? src.slice(0, mig) : src;
  if (mig >= 0) for (const m of src.slice(mig).matchAll(/pub fn (\w+)\s*\(/g)) { if (!/^(new|fn)$/.test(m[1])) gated.add(m[1]); }
  const implStart = mainPart.indexOf('impl Contract {');
  const implBody = mainPart.slice(implStart);
  const out: Method[] = [];
  const re = /(?:^|\n)(\s*)((?:#\[[^\]]*\]\s*)*)pub fn (\w+)\s*\(([^)]*)\)([^{]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(implBody))) {
    const [, , attrs, name, args, ret] = m;
    if (name === 'fn') continue;
    // body: up to the next method OR private helper (so a helper's code is never attributed to a view)
    const rest = implBody.slice(m.index + m[0].length);
    const next = rest.search(/\n    (?:#\[[^\]]*\]\s*)*(?:pub )?fn /);
    const body = next >= 0 ? rest.slice(0, next) : rest;
    const mutates = /&mut self/.test(args) || /#\[init\]/.test(attrs);
    let kind: Kind = 'view', guard: string | null = null;
    if (/#\[init\]/.test(attrs)) { kind = 'init'; guard = 'single-use (near-sdk init: panics if state already exists)'; }
    else if (/self\.assert_dao\(\)/.test(body)) { kind = 'dao'; guard = 'assert_dao: predecessor == dao'; }
    else if (/self\.assert_agent\(\)/.test(body)) { kind = 'agent'; guard = 'assert_agent: predecessor == agent'; }
    else if (/pending_dao/.test(body) && /predecessor_account_id/.test(body)) { kind = 'proposed-dao'; guard = 'only the account in pending_dao, and only while a handover is pending'; }
    else if (mutates) throw new Error(`state-changing method ${name} has no recognised guard: classify it by hand`);
    void ret;
    out.push({ name, kind, mutates, guard });
  }
  for (const g of [...gated].sort()) out.push({ name: g, kind: 'feature-gated', mutates: true, guard: '#[private] (only the contract account); built only with --features migrate' });
  return out;
}

/** What the near-sdk adds on its own (not in lib.rs): NEP-330 source metadata. */
export const SDK_ADDED = [{ name: 'contract_source_metadata', kind: 'metadata' as Kind, mutates: false, guard: null }];

export function inventory(src: string, wasm: Uint8Array) {
  const fromSource = sourceMethods(src);
  const production = fromSource.filter((m) => m.kind !== 'feature-gated');
  const expectedExports = [...production, ...SDK_ADDED].map((m) => m.name).sort();
  const actualExports = wasmFunctionExports(wasm).filter((n) => !/^(_|__|memory|table)/.test(n));
  const missingInWasm = expectedExports.filter((n) => !actualExports.includes(n));
  const unexpectedInWasm = actualExports.filter((n) => !expectedExports.includes(n));
  const all = [...production, ...SDK_ADDED, ...fromSource.filter((m) => m.kind === 'feature-gated')];
  const count = (k: Kind) => all.filter((m) => m.kind === k).length;
  return {
    methods: all,
    wasmExports: actualExports,
    missingInWasm, unexpectedInWasm,
    counts: { total: all.length, production: production.length + SDK_ADDED.length, init: count('init'), dao: count('dao'), agent: count('agent'), proposedDao: count('proposed-dao'), view: count('view'), metadata: count('metadata'), featureGated: count('feature-gated') },
    /** every method an unprivileged account must be refused */
    restricted: all.filter((m) => m.kind === 'dao' || m.kind === 'agent' || m.kind === 'proposed-dao').map((m) => m.name),
  };
}
