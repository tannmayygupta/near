// MUST be the first import of every script in scripts/mainnet/. It selects the network BEFORE schema.ts / lib.ts read the environment.
//   default            -> MAINNET (real money; every money-moving script also requires ALLOW_MAINNET=1)
//   QT_NET=testnet     -> a free REHEARSAL of the very same scripts on public testnet, with its own config set (QT_TAG=rehearsal), so nothing real is touched
process.env.QT_NET ??= 'mainnet';
if (process.env.QT_NET !== 'mainnet' && process.env.QT_NET !== 'testnet') throw new Error(`QT_NET must be mainnet or testnet (got ${process.env.QT_NET})`);
process.env.TOKEN_PROFILE = process.env.QT_NET === 'mainnet' ? 'mainnet' : 'testnet';
process.env.NEAR_NETWORK = process.env.QT_NET;
if (process.env.QT_NET === 'testnet') process.env.QT_TAG ??= 'rehearsal';
export {};
