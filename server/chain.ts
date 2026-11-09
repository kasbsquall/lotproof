// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0
// Chain side of the demo service. The server plays the supplier: it holds the
// measuring station secret, the admin secret and every lot's raw values in the
// encrypted private state store. Nothing here leaves the machine except
// commitments, counts and verdicts.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import pino from 'pino';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { type EnvironmentConfiguration, waitForFunds } from '@midnight-ntwrk/testkit-js';
import { getConfig } from '../src/config.js';
import { buildWallet, resolveSecret, syncWallet, type MidnightWalletProvider } from '../src/wallet.js';
import { buildProviders, type LotproofProviders } from '../src/providers.js';
import {
  CompiledLotproofContract,
  LotStatus,
  ledger,
  pureCircuits,
  zkConfigPath,
  createLotproofPrivateState,
  withLot,
  toHex,
  SAMPLE_SIZE,
  type LotproofPrivateState,
  type Spec,
} from '../contract/index.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

export const NETWORK = process.env['MIDNIGHT_NETWORK'] ?? 'local';
const PRIVATE_STATE_ID = 'lotproofSupplier';
const STATE_FILE = `data/demo-state.${NETWORK}.json`;
export const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

export const SPEC_ID_LABEL = 'DRW-4471-rev-C';
export const SPEC: Spec = { nominal: 12_000n, lower: 11_950n, upper: 12_050n, maxDefects: 1n };

export type TxRecord = { step: string; txHash: string; blockHeight?: number; at: string };
export type LotMeta = { id: string; label: string; createdAt: string; txs: TxRecord[]; refused?: string };
type DemoState = { contractAddress?: string; deployTx?: TxRecord[]; lots: LotMeta[] };

const asId = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(Buffer.from(label, 'utf8').subarray(0, 32));
  return out;
};
const idFromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

const loadState = (): DemoState =>
  existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DemoState) : { lots: [] };
const saveState = (s: DemoState) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

/** Simulated CMM readings in micrometres; `defects` parts land outside the band. */
export function simulateLot(defects: number): bigint[] {
  const values = Array.from({ length: SAMPLE_SIZE }, () => 11_965n + BigInt(Math.floor(Math.random() * 70)));
  const picks = new Set<number>();
  while (picks.size < defects) picks.add(Math.floor(Math.random() * SAMPLE_SIZE));
  for (const i of picks) values[i] = Math.random() < 0.5 ? 12_051n + BigInt(Math.floor(Math.random() * 40)) : 11_910n + BigInt(Math.floor(Math.random() * 39));
  return values;
}

export class LotproofChain {
  private wallet!: MidnightWalletProvider;
  private providers!: LotproofProviders;
  private state: DemoState = loadState();
  readonly specId = asId(SPEC_ID_LABEL);

  get address(): string | undefined {
    return this.state.contractAddress;
  }

  async start(): Promise<void> {
    const config = getConfig();
    const env: EnvironmentConfiguration = { walletNetworkId: config.networkId, ...config };
    this.wallet = await buildWallet(logger, env, resolveSecret(NETWORK));
    await this.wallet.start(false);
    await syncWallet(logger, this.wallet.wallet, 60 * 60_000);
    if (NETWORK !== 'local') await waitForFunds(this.wallet.wallet, env, false, this.wallet.unshieldedKeystore);
    const password = process.env['LOTPROOF_STORE_PASSWORD'];
    if (!password) throw new Error('LOTPROOF_STORE_PASSWORD is required');
    this.providers = buildProviders(this.wallet, zkConfigPath, config, `lotproof-${NETWORK}`, password);
    if (!this.state.contractAddress) await this.deploy();
    logger.info(`Lotproof ready on ${NETWORK} at ${this.state.contractAddress}`);
  }

  async stop(): Promise<void> {
    await this.wallet?.stop();
  }

  private async deploy(): Promise<void> {
    const initial = createLotproofPrivateState(new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32)));
    const deployed = await deployContract(this.providers, {
      compiledContract: CompiledLotproofContract,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: initial,
    } as never);
    const now = () => new Date().toISOString();
    this.state = {
      contractAddress: deployed.deployTxData.public.contractAddress,
      deployTx: [{ step: 'deploy', txHash: deployed.deployTxData.public.txHash, at: now() }],
      lots: [],
    };
    saveState(this.state);
    this.state.deployTx!.push(await this.call('registerStation', [pureCircuits.stationKey(initial.stationSecret)]));
    this.state.deployTx!.push(await this.call('publishSpec', [this.specId, SPEC]));
    saveState(this.state);
  }

  private async call(circuitId: string, args: unknown[]): Promise<TxRecord> {
    const r = await submitCallTx(this.providers, {
      compiledContract: CompiledLotproofContract,
      contractAddress: this.state.contractAddress!,
      privateStateId: PRIVATE_STATE_ID,
      circuitId,
      args,
    } as never);
    return { step: circuitId, txHash: r.public.txHash, blockHeight: r.public.blockHeight, at: new Date().toISOString() };
  }

  private async updatePrivate(f: (s: LotproofPrivateState) => LotproofPrivateState): Promise<void> {
    const view = this.providers.privateStateProvider.forContract(this.state.contractAddress!);
    const current = (await view.get(PRIVATE_STATE_ID)) as LotproofPrivateState | null;
    if (!current) throw new Error('Supplier private state not found');
    await view.set(PRIVATE_STATE_ID, f(current));
  }

  private newLot(): { id: Uint8Array; meta: LotMeta } {
    const n = this.state.lots.length + 1;
    const label = `LOT-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(n).padStart(3, '0')}`;
    const id = asId(label);
    const meta: LotMeta = { id: toHex(id), label, createdAt: new Date().toISOString(), txs: [] };
    this.state.lots.unshift(meta);
    return { id, meta };
  }

  /** Station measures and commits, then the supplier proves. */
  async measureAndProve(defects: number, onStep: (s: string) => void): Promise<LotMeta> {
    const { id, meta } = this.newLot();
    onStep('measuring');
    await this.updatePrivate((s) => withLot(s, id, { values: simulateLot(defects), salt: new Uint8Array(randomBytes(32)) }));
    onStep('committing');
    meta.txs.push(await this.call('commitLot', [id, this.specId]));
    saveState(this.state);
    onStep('proving');
    meta.txs.push(await this.call('proveLot', [id]));
    saveState(this.state);
    return meta;
  }

  /** Station commits real readings; someone swaps in better numbers and tries to prove. */
  async tamperAttempt(onStep: (s: string) => void): Promise<LotMeta> {
    const { id, meta } = this.newLot();
    const salt = new Uint8Array(randomBytes(32));
    onStep('measuring');
    await this.updatePrivate((s) => withLot(s, id, { values: simulateLot(3), salt }));
    onStep('committing');
    meta.txs.push(await this.call('commitLot', [id, this.specId]));
    saveState(this.state);
    onStep('tampering');
    await this.updatePrivate((s) => withLot(s, id, { values: simulateLot(0), salt }));
    onStep('proving');
    try {
      meta.txs.push(await this.call('proveLot', [id]));
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      meta.refused = /do not match the station commitment/.test(msg)
        ? 'Measurements do not match the station commitment'
        : 'The contract refused the proof';
    }
    saveState(this.state);
    return meta;
  }

  async disclose(lotHex: string, index: number): Promise<TxRecord> {
    const meta = this.state.lots.find((l) => l.id === lotHex);
    if (!meta) throw new Error('Unknown lot');
    const tx = await this.call('disclosePart', [idFromHex(lotHex), BigInt(index)]);
    meta.txs.push(tx);
    saveState(this.state);
    return tx;
  }

  /**
   * The supplier's own copy of a lot's raw values, for the "supplier view" of
   * the demo. In production this never leaves the supplier's network; here the
   * service is the supplier machine and the values are simulated.
   */
  async supplierLot(lotHex: string): Promise<{ id: string; valuesUm: number[] } | null> {
    if (!this.state.lots.some((l) => l.id === lotHex)) return null;
    const view = this.providers.privateStateProvider.forContract(this.state.contractAddress!);
    const ps = (await view.get(PRIVATE_STATE_ID)) as LotproofPrivateState | null;
    const lot = ps?.lots[lotHex];
    return lot ? { id: lotHex, valuesUm: lot.values.map(Number) } : null;
  }

  /** Public view: what any customer could read from the indexer, plus tx hashes. */
  async publicView() {
    const read = await this.providers.publicDataProvider.queryContractState(this.state.contractAddress!);
    if (!read) throw new Error('Contract state not found');
    const l = ledger(read.contractState.deserialize({ v9: ContractState }).data);
    const spec = l.specs.lookup(this.specId);
    const lots = this.state.lots.map((meta) => {
      const id = idFromHex(meta.id);
      if (!l.lots.member(id)) return { ...meta, status: 'measuring' };
      const rec = l.lots.lookup(id);
      const disclosed = l.disclosed.member(id)
        ? [...l.disclosed.lookup(id)].map(([i, v]) => ({ index: Number(i), valueUm: Number(v) }))
        : [];
      return {
        ...meta,
        status: meta.refused ? 'refused' : LotStatus[rec.status].toLowerCase(),
        inTolerance: Number(rec.inTolerance),
        sampleSize: Number(rec.sampleSize),
        commitment: toHex(rec.commitment),
        station: toHex(rec.station),
        disclosed,
      };
    });
    return {
      network: NETWORK,
      contractAddress: this.state.contractAddress,
      setupTxs: this.state.deployTx ?? [],
      provenLots: Number(l.provenLots),
      spec: {
        id: SPEC_ID_LABEL,
        nominalUm: Number(spec.nominal),
        lowerUm: Number(spec.lower),
        upperUm: Number(spec.upper),
        maxDefects: Number(spec.maxDefects),
      },
      lots,
    };
  }
}
