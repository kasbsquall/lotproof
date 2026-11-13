// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0
// End-to-end run against a real Midnight network (local devnet or Preview):
// real ZK proofs from the proof server, real transactions, state read back
// from the indexer. Wallet bootstrapping follows midnightntwrk/example-hello-world.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { ContractState, type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { type EnvironmentConfiguration, waitForFunds } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';

import { getConfig } from '../config.js';
import { type MidnightWalletProvider, syncWallet, buildWallet, resolveSecret } from '../wallet.js';
import { buildProviders, type LotproofProviders } from '../providers.js';
import {
  CompiledLotproofContract,
  LotStatus,
  ledger,
  pureCircuits,
  zkConfigPath,
  createLotproofPrivateState,
  withLot,
  toHex,
  type LotproofPrivateState,
  type Spec,
} from '../../contract/index.js';
import { bytes32, idFrom } from './lotproof.simulator.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const PRIVATE_STATE_ID = 'lotproofSupplierState';
const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });

const SHAFT: Spec = { nominal: 12_000n, lower: 11_950n, upper: 12_050n, maxDefects: 1n };
const SPEC_ID = idFrom('DRW-4471-rev-C');
const good = (): bigint[] => Array.from({ length: 32 }, (_, i) => 11_970n + BigInt((i * 7) % 60));

describe(`Lotproof end to end (${network})`, () => {
  let wallet: MidnightWalletProvider;
  let providers: LotproofProviders;
  let address: ContractAddress;
  const config = getConfig();
  const isRemote = network !== 'local';
  const txLog: { step: string; txHash: string; blockHeight?: number }[] = [];

  const readLedger = async () => {
    const read = await providers.publicDataProvider.queryContractState(address);
    expect(read).not.toBeNull();
    return ledger(read!.contractState.deserialize({ v9: ContractState }).data);
  };

  const call = async (step: string, circuitId: string, args: unknown[]) => {
    const r = await submitCallTx(providers, {
      compiledContract: CompiledLotproofContract,
      contractAddress: address,
      privateStateId: PRIVATE_STATE_ID,
      circuitId,
      args,
    } as never);
    txLog.push({ step, txHash: r.public.txHash, blockHeight: r.public.blockHeight });
    logger.info(`${step}: tx ${r.public.txHash}`);
  };

  const updatePrivate = async (f: (s: LotproofPrivateState) => LotproofPrivateState) => {
    const current = (await providers.privateStateProvider.forContract(address).get(PRIVATE_STATE_ID)) as LotproofPrivateState;
    await providers.privateStateProvider.forContract(address).set(PRIVATE_STATE_ID, f(current));
  };

  beforeAll(async () => {
    const env: EnvironmentConfiguration = { walletNetworkId: config.networkId, ...config };
    wallet = await buildWallet(logger, env, resolveSecret(network));
    await wallet.start(false);
    await syncWallet(logger, wallet.wallet, isRemote ? 60 * 60_000 : 10 * 60_000);
    if (isRemote) await waitForFunds(wallet.wallet, env, false, wallet.unshieldedKeystore);
    providers = buildProviders(wallet, zkConfigPath, config);
  });

  afterAll(async () => {
    if (address) {
      writeFileSync(
        `deployment.${network}.json`,
        JSON.stringify({ network, contractAddress: address, transactions: txLog }, null, 2),
      );
    }
    if (wallet) await wallet.stop();
  });

  it('deploys with the supplier as admin and the customer fixed at deployment', async () => {
    const initial = createLotproofPrivateState(bytes32(), bytes32(), bytes32());
    const deployed = await deployContract(providers, {
      compiledContract: CompiledLotproofContract,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: initial,
      args: [pureCircuits.customerKey(initial.customerSecret)],
    } as never);
    address = deployed.deployTxData.public.contractAddress;
    txLog.push({ step: 'deploy', txHash: deployed.deployTxData.public.txHash });
    logger.info(`Lotproof deployed at ${address}`);
    const l = await readLedger();
    expect(l.admin).toEqual(pureCircuits.adminKey(initial.adminSecret));
    expect(l.customer).toEqual(pureCircuits.customerKey(initial.customerSecret));
  });

  it('lets the customer approve the measuring station and publish the drawing spec', async () => {
    const ps = (await providers.privateStateProvider.forContract(address).get(PRIVATE_STATE_ID)) as LotproofPrivateState;
    await call('registerStation', 'registerStation', [pureCircuits.stationKey(ps.stationSecret)]);
    await call('publishSpec', 'publishSpec', [SPEC_ID, SHAFT]);
    const l = await readLedger();
    expect(l.specs.lookup(SPEC_ID).upper).toBe(SHAFT.upper);
  });

  it('commits a lot at measuring time and proves 32 of 32 in tolerance', async () => {
    const lot = idFrom(`LOT-${Date.now()}`);
    const values = good();
    await updatePrivate((s) => withLot(s, lot, { values, salt: bytes32() }));
    await call('commitLot', 'commitLot', [lot, SPEC_ID]);
    await call('proveLot', 'proveLot', [lot]);
    const rec = (await readLedger()).lots.lookup(lot);
    expect(rec.status).toBe(LotStatus.Accepted);
    expect(rec.inTolerance).toBe(32n);
    logger.info(`Lot ${toHex(lot)} accepted 32/32 without publishing a single measurement`);
  });

  it('refuses to prove a lot whose measurements were changed after the commit', async () => {
    const lot = idFrom(`TAMPER-${Date.now()}`);
    const salt = bytes32();
    const bad = good().map((v, i) => (i < 3 ? 12_090n : v));
    await updatePrivate((s) => withLot(s, lot, { values: bad, salt }));
    await call('commitLot (tamper case)', 'commitLot', [lot, SPEC_ID]);
    await updatePrivate((s) => withLot(s, lot, { values: good(), salt }));
    await expect(
      submitCallTx(providers, {
        compiledContract: CompiledLotproofContract,
        contractAddress: address,
        privateStateId: PRIVATE_STATE_ID,
        circuitId: 'proveLot',
        args: [lot],
      } as never),
    ).rejects.toThrow(/do not match the station commitment/);
    const l = await readLedger();
    expect(l.lots.lookup(lot).status).toBe(LotStatus.Committed);
    expect(l.committedLots - l.provenLots).toBe(1n);
  });
});
