// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0
// Prints the unshielded address and balances of the network's project wallet,
// so it can be funded from the faucet. Never prints the seed.

import pino from 'pino';
import { DAppConnectorWalletAdapter, type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { getConfig } from '../src/config.js';
import { buildWallet, resolveSecret, syncWallet } from '../src/wallet.js';

const network = process.env['MIDNIGHT_NETWORK'] ?? 'preview';
const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'warn' });
const config = getConfig();
const env: EnvironmentConfiguration = { walletNetworkId: config.networkId, ...config };

const wallet = await buildWallet(logger, env, resolveSecret(network));
await wallet.start(false);
const adapter = new DAppConnectorWalletAdapter(wallet, env);
const { unshieldedAddress } = await adapter.getUnshieldedAddress();
console.log(`network: ${network}`);
console.log(`unshielded address: ${unshieldedAddress}`);
if (process.argv.includes('--balances')) {
  await syncWallet(logger, wallet.wallet, 30 * 60_000);
  const night = await adapter.getUnshieldedBalances();
  const dust = await adapter.getDustBalance();
  console.log(`NIGHT: ${JSON.stringify(night, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  console.log(`DUST: ${dust.balance.toString()} (cap ${dust.cap.toString()})`);
}
await wallet.stop();
process.exit(0);
