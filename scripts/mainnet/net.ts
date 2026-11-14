// Network profile for the mainnet slice and its testnet rehearsal. Everything that differs between the two lives here and nowhere else.
import './profile.js';
import { readFileSync } from 'node:fs';
import { RPC } from '../../src/near/chain.js';
import { envFileSetsAllowMainnet } from '../../src/near/setup-plan.js';
import { requireSafeSecretDir } from '../../src/near/secret-dir.js';

export const IS_MAINNET = process.env.QT_NET === 'mainnet';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'; // native USDC on NEAR (Circle)

export const P = IS_MAINNET
  ? {
      name: 'mainnet' as const, rpc: RPC.mainnet, factory: 'sputnik-dao.near',
      dex: 'v2.ref-finance.near', wrap: 'wrap.near', stable: USDC, stableSymbol: 'USDC',
      poolIds: [4512] as number[] | undefined, // Ref pool wNEAR/USDC (about US$1.3M liquidity, 0.3% fee when this slice was built); re-read and price-checked on every trade
      sellToken: 'nep141:wrap.near', buyToken: `nep141:${USDC}`,
      explorerHost: 'https://nearblocks.io',
    }
  : {
      name: 'testnet (rehearsal)' as const, rpc: RPC.testnet, factory: 'sputnikv2.testnet',
      dex: 'ref-finance-101.testnet', wrap: 'wrap.testnet', stable: 'usdt.fakes.testnet', stableSymbol: 'USDT.e',
      poolIds: undefined as number[] | undefined,
      sellToken: 'nep141:wrap.testnet', buyToken: 'nep141:usdt.fakes.testnet',
      explorerHost: 'https://explorer.testnet.near.org',
    };

/** Hard limits of the mainnet slice. They are deliberately tiny: this slice proves the machine works with real money, it is not a treasury. */
export const LIMITS = {
  /** the most NEAR any mandate of this slice may sell */
  maxSellNear: process.env.QT_MAX_SELL ?? (IS_MAINNET ? '0.6' : '0.3'), // the thin testnet pool cannot absorb more in a rehearsal
  /** budget the owner must hold before setup starts (see docs/MAINNET.md for the line items) */
  setupNear: 16,
};

/** Refuse to touch real money unless the owner said so explicitly in the environment of THIS command. */
export function requireMainnetConsent(action: string) {
  if (!IS_MAINNET) return;
  // consent must be typed into the shell of THIS command; a line in .env would make it permanent and invisible
  let envText = ''; try { envText = readFileSync('.env', 'utf8'); } catch { /* no .env */ }
  if (envFileSetsAllowMainnet(envText)) {
    console.error('REFUSING: .env contains ALLOW_MAINNET. Remove that line; set it only in the shell of the command ($env:ALLOW_MAINNET=\'1\').');
    process.exit(2);
  }
  if (process.env.ALLOW_MAINNET !== '1') {
    console.error(`REFUSING to ${action} on MAINNET: set ALLOW_MAINNET=1 for this command to confirm you mean real money.`);
    process.exit(2);
  }
  requireSafeSecretDir(true);
}
