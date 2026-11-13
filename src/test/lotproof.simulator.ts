// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0
// In-memory runner for the Lotproof contract, modelled on the simulator in
// midnightntwrk/midnight-examples (zk-loan), Apache-2.0.

import { randomBytes } from 'node:crypto';
import {
  type ChargedState,
  type CircuitContext,
  type CircuitResults,
  type EncodedZswapLocalState,
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { Contract, type Ledger, ledger, pureCircuits, type Spec } from '../../contract/index.js';
import {
  type LotproofPrivateState,
  type PrivateLot,
  createLotproofPrivateState,
  witnesses,
  withLot,
} from '../../contract/witnesses.js';
import { createEitherTestUser } from './address.js';

type Circuit = (
  context: CircuitContext<LotproofPrivateState>,
) => Promise<CircuitResults<LotproofPrivateState, unknown>>;

export const bytes32 = (): Uint8Array => new Uint8Array(randomBytes(32));
export const idFrom = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(Buffer.from(label, 'utf8').subarray(0, 32));
  return out;
};

export class LotproofSimulator {
  readonly contract: Contract<LotproofPrivateState>;
  readonly address = sampleContractAddress();
  state!: ChargedState;
  privateState!: LotproofPrivateState;
  private zswapLocalState!: EncodedZswapLocalState;
  private readonly coinPublicKey = createEitherTestUser('Supplier').left.hex;

  private constructor(overrides: Partial<typeof witnesses>) {
    this.contract = new Contract<LotproofPrivateState>({ ...witnesses, ...overrides });
  }

  static async create(overrides: Partial<typeof witnesses> = {}): Promise<LotproofSimulator> {
    const sim = new LotproofSimulator(overrides);
    const initial = createLotproofPrivateState(bytes32(), bytes32(), bytes32());
    const r = await sim.contract.initialState(
      createConstructorContext(initial, sim.coinPublicKey),
      pureCircuits.customerKey(initial.customerSecret),
    );
    sim.state = r.currentContractState.data;
    sim.privateState = r.currentPrivateState;
    sim.zswapLocalState = r.currentZswapLocalState;
    return sim;
  }

  private async run(circuitId: string, circuit: Circuit): Promise<Ledger> {
    const context = createCircuitContext<LotproofPrivateState>({
      circuitId,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: this.zswapLocalState,
      contractState: this.state,
      privateState: this.privateState,
    });
    const { context: after } = await circuit(context);
    this.state = after.callContext.currentQueryContext.state;
    this.privateState = after.callContext.currentPrivateState as LotproofPrivateState;
    this.zswapLocalState = after.callContext.currentZswapLocalState ?? this.zswapLocalState;
    return ledger(this.state);
  }

  getLedger(): Ledger {
    return ledger(this.state);
  }

  stationKey(): Uint8Array {
    return pureCircuits.stationKey(this.privateState.stationSecret);
  }

  /** Stores raw measurements on the supplier side (never on the ledger). */
  measure(lotId: Uint8Array, lot: PrivateLot): void {
    this.privateState = withLot(this.privateState, lotId, lot);
  }

  /** Swaps some of the caller's secrets, to act as an outsider or as another role. */
  impersonate(secrets: Partial<Pick<LotproofPrivateState, 'adminSecret' | 'customerSecret' | 'stationSecret'>>): void {
    this.privateState = { ...this.privateState, ...secrets };
  }

  registerStation(station: Uint8Array, specId: Uint8Array) {
    return this.run('registerStation', (c) => this.contract.impureCircuits.registerStation(c, station, specId));
  }
  revokeStation(station: Uint8Array) {
    return this.run('revokeStation', (c) => this.contract.impureCircuits.revokeStation(c, station));
  }
  publishSpec(specId: Uint8Array, spec: Spec) {
    return this.run('publishSpec', (c) => this.contract.impureCircuits.publishSpec(c, specId, spec));
  }
  commitLot(lotId: Uint8Array) {
    return this.run('commitLot', (c) => this.contract.impureCircuits.commitLot(c, lotId));
  }
  requestAudit(lotId: Uint8Array, specId: Uint8Array) {
    return this.run('requestAudit', (c) => this.contract.impureCircuits.requestAudit(c, lotId, specId));
  }
  answerAudit(lotId: Uint8Array, specId: Uint8Array) {
    return this.run('answerAudit', (c) => this.contract.impureCircuits.answerAudit(c, lotId, specId));
  }
  proveLot(lotId: Uint8Array) {
    return this.run('proveLot', (c) => this.contract.impureCircuits.proveLot(c, lotId));
  }
  disclosePart(lotId: Uint8Array, index: bigint) {
    return this.run('disclosePart', (c) => this.contract.impureCircuits.disclosePart(c, lotId, index));
  }
}
