'use client';
// Real NEAR wallet login/signing via @near-wallet-selector (MyNearWallet module). Loaded lazily on the client only.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ENV } from '@/lib/data';

export type FnCall = { methodName: string; args: object; gas: string; deposit: string };
type Ctx = {
  ready: boolean;
  accountId: string | null;
  error: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  /** Signs + sends a single-action function call transaction with the connected wallet. */
  call: (receiverId: string, fc: FnCall) => Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
  /** NEP-413 message signature (used for council-only sealed-term access). */
  signMessage: (message: string, recipient: string) => Promise<{ ok: true; signature: string; publicKey: string } | { ok: false; error: string }>;
};
const WalletCtx = createContext<Ctx | null>(null);
export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error('useWallet outside WalletProvider');
  return c;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function WalletProvider({ children }: { children: ReactNode }) {
  const selectorRef = useRef<any>(null);
  const modalRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    (async () => {
      try {
        const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }] = await Promise.all([
          import('@near-wallet-selector/core'),
          import('@near-wallet-selector/modal-ui'),
          import('@near-wallet-selector/my-near-wallet'),
        ]);
        await import('@near-wallet-selector/modal-ui/styles.css' as string).catch(() => undefined);
        const selector: any = await setupWalletSelector({ network: ENV.network, modules: [setupMyNearWallet() as any] });
        selectorRef.current = selector;
        modalRef.current = setupModal(selector, { contractId: ENV.dao || ENV.mandate || 'guest-book.testnet' } as any);
        const sync = () => setAccountId(selector.store.getState().accounts.find((a: any) => a.active)?.accountId ?? null);
        sync();
        sub = selector.store.observable.subscribe(sync);
        setReady(true);
      } catch (e) {
        setError(`Wallet selector failed to load: ${(e as Error).message}`);
      }
    })();
    return () => sub?.unsubscribe();
  }, []);

  const connect = useCallback(() => modalRef.current?.show(), []);
  const disconnect = useCallback(async () => {
    try { const w = await selectorRef.current?.wallet(); await w?.signOut(); } catch { /* ignore */ }
    setAccountId(null);
  }, []);

  const call: Ctx['call'] = useCallback(async (receiverId, fc) => {
    try {
      const w = await selectorRef.current.wallet();
      const res = await w.signAndSendTransaction({
        receiverId,
        actions: [{ type: 'FunctionCall', params: { methodName: fc.methodName, args: fc.args, gas: fc.gas, deposit: fc.deposit } }],
      });
      return { ok: true as const, detail: JSON.stringify(res?.transaction?.hash ?? res ?? 'sent').slice(0, 200) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, []);

  const signMessage: Ctx['signMessage'] = useCallback(async (message, recipient) => {
    try {
      const w = await selectorRef.current.wallet();
      if (!w.signMessage) return { ok: false as const, error: 'This wallet does not support NEP-413 signMessage.' };
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const r = await w.signMessage({ message, nonce: Buffer.from(nonce), recipient });
      return { ok: true as const, signature: String(r.signature), publicKey: String(r.publicKey) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, []);

  return <WalletCtx.Provider value={{ ready, accountId, error, connect, disconnect, call, signMessage }}>{children}</WalletCtx.Provider>;
}

export function WalletButton() {
  const w = useWallet();
  if (w.error) return <span className="pill bad" title={w.error}>wallet unavailable</span>;
  if (!w.ready) return <button disabled>Wallet…</button>;
  return w.accountId ? (
    <button onClick={() => void w.disconnect()} title="Disconnect">{w.accountId.length > 22 ? `${w.accountId.slice(0, 10)}…${w.accountId.slice(-6)}` : w.accountId}</button>
  ) : (
    <button className="primary" onClick={w.connect}>Connect NEAR wallet</button>
  );
}
