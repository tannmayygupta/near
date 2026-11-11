// READ-ONLY smoke check against the live OutLayer API using a wk_ key. Calls only: address, confidential balance, swap quote. Moves no money.
// usage: OUTLAYER_WK=wk_... npx tsx scripts/outlayer-readonly-check.ts      (or pass a JSON file path with {"api_key": "..."} as argv[2])
import { readFileSync } from 'node:fs';
import { OutLayerClient } from '../src/near/outlayer';

const file = process.argv[2];
const key = process.env.OUTLAYER_WK ?? (file ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')).api_key : undefined);
if (!key) { console.error('set OUTLAYER_WK or pass a creds file path'); process.exit(2); }
const c = new OutLayerClient({ apiKey: key });
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
console.log('address           ', (await c.address()).address);
console.log('confidential bal  ', JSON.stringify((await c.confidentialBalance()).balances));
console.log('confidential quote', JSON.stringify(await c.confidentialSwapQuote({ token_in: USDC, token_out: 'nep141:wrap.near', amount_in: '10000000' })));
