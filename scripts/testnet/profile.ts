// MUST be the first import of every testnet-real script: switches the token profile (wNEAR/USDT.e on NEAR testnet) before schema.ts is used.
process.env.TOKEN_PROFILE = 'testnet';
process.env.NEAR_NETWORK = 'testnet';
export {};
