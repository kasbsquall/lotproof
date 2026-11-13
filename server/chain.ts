// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0
// Chain side of the demo service. The server plays all three roles: it holds
// the customer secret, the measuring station secret, the supplier admin secret
// and every lot's raw values in the encrypted private state store. In a real
// deployment each secret lives on its owner's machine. Nothing here leaves the
// machine except commitments, counts and verdicts.

import { createHash, randomBytes } from 'node:crypto';
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
// A tighter band the customer publishes later to audit lots already committed.
export const AUDIT_ID_LABEL = 'DRW-4471-rev-C audit, tight band';
export const AUDIT_SPEC: Spec = { nominal: 12_000n, lower: 11_980n, upper: 12_020n, maxDefects: 0n };

export type TxRecord = { step: string; txHash: string; blockHeight?: number; at: string };
export type LotMeta = { id: string; label: string; createdAt: string; txs: TxRecord[]; refused?: string };
// idKey is shared by supplier and customer off-chain and never served.
type DemoState = { contractAddress?: string; idKey?: string; deployTx?: TxRecord[]; lots: LotMeta[] };

/**
 * On-chain id of a lot or drawing: a keyed hash of its label. Labels such as
 * DRW-4471-rev-C or LOT-261110-002 never reach the ledger, and without the key
 * nobody can test guesses against the ids that do.
 */
const asId = (idKey: string, label: string): Uint8Array =>
  new Uint8Array(
    createHash('sha256').update('lotproof:id:v1').update(Buffer.from(idKey, 'hex')).update(label, 'utf8').digest(),
  );
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

  get specId(): Uint8Array {
    return asId(this.state.idKey!, SPEC_ID_LABEL);
  }

  get auditId(): Uint8Array {
    return asId(this.state.idKey!, AUDIT_ID_LABEL);
  }

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
    await this.ensureSetup();
    logger.info(`Lotproof ready on ${NETWORK} at ${this.state.contractAddress}`);
  }

  async stop(): Promise<void> {
    await this.wallet?.stop();
  }

  private async deploy(): Promise<void> {
    const secret = () => new Uint8Array(randomBytes(32));
    const initial = createLotproofPrivateState(secret(), secret(), secret());
    const deployed = await deployContract(this.providers, {
      compiledContract: CompiledLotproofContract,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: initial,
      args: [pureCircuits.customerKey(initial.customerSecret)],
    } as never);
    const now = () => new Date().toISOString();
    this.state = {
      contractAddress: deployed.deployTxData.public.contractAddress,
      idKey: randomBytes(32).toString('hex'),
      deployTx: [{ step: 'deploy', txHash: deployed.deployTxData.public.txHash, at: now() }],
      lots: [],
    };
    saveState(this.state);
  }

  private async readLedger() {
    const read = await this.providers.publicDataProvider.queryContractState(this.state.contractAddress!);
    if (!read) throw new Error('Contract state not found');
    return ledger(read.contractState.deserialize({ v9: ContractState }).data);
  }

  /**
   * The customer's setup: publish the spec, approve the station for it, publish
   * the audit band. Each step runs only if the ledger does not have it yet, so a
   * restart after a failed step resumes instead of leaving the demo stuck.
   */
  private async ensureSetup(): Promise<void> {
    const view = this.providers.privateStateProvider.forContract(this.state.contractAddress!);
    const ps = (await view.get(PRIVATE_STATE_ID)) as LotproofPrivateState | null;
    if (!ps) throw new Error('Private state not found');
    const station = pureCircuits.stationKey(ps.stationSecret);
    const steps: [string, (l: Awaited<ReturnType<LotproofChain['readLedger']>>) => boolean, unknown[]][] = [
      ['publishSpec', (l) => l.specs.member(this.specId), [this.specId, SPEC]],
      ['registerStation', (l) => l.stations.member(station), [station, this.specId]],
      ['publishSpec', (l) => l.specs.member(this.auditId), [this.auditId, AUDIT_SPEC]],
    ];
    for (const [circuit, done, args] of steps) {
      if (done(await this.readLedger())) continue;
      this.state.deployTx = [...(this.state.deployTx ?? []), await this.call(circuit, args)];
      saveState(this.state);
    }
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
    const id = asId(this.state.idKey!, label);
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
    meta.txs.push(await this.call('commitLot', [id]));
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
    meta.txs.push(await this.call('commitLot', [id]));
    saveState(this.state);
    onStep('tampering');
    await this.updatePrivate((s) => withLot(s, id, { values: simulateLot(0), salt }));
    onStep('proving');
    try {
      meta.txs.push(await this.call('proveLot', [id]));
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // Only the contract's own assertion counts as a refusal; anything else
      // (proof server, indexer, network) fails the job instead.
      if (!/do not match the station commitment/.test(msg)) throw e;
      meta.refused = 'Measurements do not match the station commitment';
    }
    saveState(this.state);
    return meta;
  }

  /** Customer asks a new question about a committed lot; supplier answers from the same commitment. */
  async audit(lotHex: string, onStep: (s: string) => void): Promise<LotMeta> {
    const meta = this.state.lots.find((l) => l.id === lotHex);
    if (!meta) throw new Error('Unknown lot');
    const id = idFromHex(lotHex);
    onStep('requesting');
    meta.txs.push({ ...(await this.call('requestAudit', [id, this.auditId])), step: 'requestAudit' });
    saveState(this.state);
    onStep('answering');
    meta.txs.push({ ...(await this.call('answerAudit', [id, this.auditId])), step: 'answerAudit' });
    saveState(this.state);
    return meta;
  }

  /** What the HTTP layer checks before queueing a job, so a doomed request does not take a turn. */
  canAudit(lotHex: string): boolean {
    const m = this.state.lots.find((l) => l.id === lotHex);
    return !!m && !m.refused && m.txs.some((t) => t.step === 'commitLot') && !m.txs.some((t) => t.step === 'requestAudit');
  }

  canDisclose(lotHex: string): boolean {
    const m = this.state.lots.find((l) => l.id === lotHex);
    return !!m && m.txs.some((t) => t.step === 'proveLot');
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
    const l = await this.readLedger();
    const spec = l.specs.lookup(this.specId);
    const auditSpec = l.specs.member(this.auditId) ? l.specs.lookup(this.auditId) : null;
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
        audit: (() => {
          const k = pureCircuits.auditKey(id, this.auditId);
          if (!l.audits.member(k)) return null;
          const a = l.audits.lookup(k);
          return { answered: a.answered, inTolerance: a.answered ? Number(a.inTolerance) : null };
        })(),
      };
    });
    return {
      network: NETWORK,
      contractAddress: this.state.contractAddress,
      setupTxs: this.state.deployTx ?? [],
      committedLots: Number(l.committedLots),
      provenLots: Number(l.provenLots),
      requestedAudits: Number(l.requestedAudits),
      answeredAudits: Number(l.answeredAudits),
      auditSpec: auditSpec
        ? {
            id: AUDIT_ID_LABEL,
            nominalUm: Number(auditSpec.nominal),
            lowerUm: Number(auditSpec.lower),
            upperUm: Number(auditSpec.upper),
          }
        : null,
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
