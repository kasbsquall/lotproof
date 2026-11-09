import type { WalletFacade, FacadeState } from '@midnightntwrk/wallet-sdk-facade';
import {
  type DustWalletOptions,
  type EnvironmentConfiguration,
  FluentWalletBuilder,
  MidnightWalletProvider,
  syncWallet as testkitSyncWallet,
  type WalletSeeds,
} from '@midnight-ntwrk/testkit-js';
import { LedgerParameters } from '@midnight-ntwrk/midnight-js-protocol/v9';
import type { UnshieldedKeystore } from '@midnightntwrk/wallet-sdk';
import type { Logger } from 'pino';

export { MidnightWalletProvider };

export type WalletSecret =
  | { kind: 'seed'; value: string }
  | { kind: 'mnemonic'; value: string };

/**
 * Builds testkit's era-aware wallet provider (it declares `supportedEras` and
 * balances/submits for ledger 9) from a seed or mnemonic, without starting it.
 */
export async function buildWallet(
  logger: Logger,
  env: EnvironmentConfiguration,
  secret: WalletSecret,
): Promise<MidnightWalletProvider> {
  const dustOptions: DustWalletOptions = {
    ledgerParams: LedgerParameters.initialParameters(),
    additionalFeeOverhead: 1_000n,
    feeBlocksMargin: 5,
  };
  const fluent = FluentWalletBuilder.forEnvironment(env);
  // Fresh starts on a chain past the v9 fork skip the ledger-8 dust history (the chain re-emitted its dust as v9
  // events when it crossed), so DUST syncs from the boundary instead of replaying every older event. Dust only; the
  // wallet's ledger-8 dust transaction history is not recorded. testkit does not expose the option, so set it on the
  // config it spreads into the dust wallet. Disable with MIDNIGHT_FULL_DUST_HISTORY=1.
  if (process.env['MIDNIGHT_FULL_DUST_HISTORY'] !== '1') {
    (fluent as unknown as { config: Record<string, unknown> }).config['skipLedgerV8DustHistory'] = true;
  }
  const base = fluent.withDustOptions(dustOptions);
  const builder =
    secret.kind === 'mnemonic' ? base.withMnemonic(secret.value) : base.withSeed(secret.value);
  const { wallet, seeds, keystore } = (await builder.buildWithoutStarting()) as {
    wallet: WalletFacade;
    seeds: WalletSeeds;
    keystore: UnshieldedKeystore;
  };
  logger.info(`Wallet built from ${secret.kind}`);
  return MidnightWalletProvider.withWallet(logger, env, wallet, seeds, keystore);
}

/** Waits for all three wallet variants to finish syncing (testkit's progress-aware implementation). */
export async function syncWallet(
  logger: Logger,
  wallet: WalletFacade,
  timeout = 300_000,
): Promise<FacadeState> {
  logger.info('Syncing wallet...');
  return testkitSyncWallet(wallet, 1_000, timeout);
}

const LOCAL_DEV_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/**
 * Local devnet uses its pre-funded genesis wallet. Remote networks read
 * MIDNIGHT_<NETWORK>_SEED or MIDNIGHT_<NETWORK>_MNEMONIC from .env.<network>.
 */
export function resolveSecret(net: string): WalletSecret {
  if (net === 'local') return { kind: 'seed', value: LOCAL_DEV_SEED };
  const upper = net.toUpperCase();
  const mnemonic = process.env[`MIDNIGHT_${upper}_MNEMONIC`]?.trim().replace(/\s+/g, ' ');
  const seed = process.env[`MIDNIGHT_${upper}_SEED`]?.trim();
  if (mnemonic && seed) throw new Error(`Set only one of MIDNIGHT_${upper}_MNEMONIC or MIDNIGHT_${upper}_SEED`);
  if (mnemonic) return { kind: 'mnemonic', value: mnemonic };
  if (seed) {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) throw new Error(`MIDNIGHT_${upper}_SEED must be 64 hex characters`);
    return { kind: 'seed', value: seed };
  }
  throw new Error(`Set MIDNIGHT_${upper}_SEED or MIDNIGHT_${upper}_MNEMONIC in .env.${net}`);
}
