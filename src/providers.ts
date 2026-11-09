import { type MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { type MidnightWalletProvider } from './wallet.js';
import { type NetworkConfig } from './config.js';

export type LotproofCircuits = 'registerStation' | 'publishSpec' | 'commitLot' | 'proveLot' | 'disclosePart';

export type LotproofProviders = MidnightProviders<any>;

export function buildProviders(
    wallet: MidnightWalletProvider,
    zkConfigPath: string,
    config: NetworkConfig,
    // Tests use a throwaway store; the demo server passes a stable name and a
    // password from the environment so lots survive restarts.
    storeName = `lotproof-test-${Date.now()}`,
    storePassword = 'Lotproof-Test-Store-1!',
): LotproofProviders {
    const zkConfigProvider = new NodeZkConfigProvider<LotproofCircuits>(zkConfigPath);

    return {
        privateStateProvider: levelPrivateStateProvider({
            privateStateStoreName: storeName,
            privateStoragePasswordProvider: () => storePassword,
            accountId: wallet.getCoinPublicKey(),
        }),
        publicDataProvider: indexerPublicDataProvider(
            config.indexer,
            config.indexerWS,
        ),
        zkConfigProvider,
        proofProvider: httpClientProofProvider(
            config.proofServer,
            zkConfigProvider,
        ),
        walletProvider: wallet,
        config: { networkId: config.networkId, ttlSeconds: 3600 },
        midnightProvider: wallet,
    };
}
