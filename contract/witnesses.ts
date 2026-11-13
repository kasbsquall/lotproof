// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0

import { type Witnesses } from './managed/lotproof/contract/index.js';

export const SAMPLE_SIZE = 32;

/** Raw measurements of one lot, kept only on the supplier's machines. */
export type PrivateLot = {
  values: bigint[]; // micrometres, length SAMPLE_SIZE
  salt: Uint8Array; // 32 bytes, hides the values behind the commitment
};

export type LotproofPrivateState = {
  adminSecret: Uint8Array;
  // In a real deployment each role keeps its own secret on its own machine.
  // The demo service plays all three roles, so one private state holds them.
  customerSecret: Uint8Array;
  stationSecret: Uint8Array;
  lots: Record<string, PrivateLot>;
};

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export const createLotproofPrivateState = (
  adminSecret: Uint8Array,
  customerSecret: Uint8Array,
  stationSecret: Uint8Array,
): LotproofPrivateState => ({ adminSecret, customerSecret, stationSecret, lots: {} });

/** Adds a lot to private state without mutating the previous object. */
export const withLot = (
  state: LotproofPrivateState,
  lotId: Uint8Array,
  lot: PrivateLot,
): LotproofPrivateState => {
  if (lot.values.length !== SAMPLE_SIZE) {
    throw new Error(`A lot must have exactly ${SAMPLE_SIZE} measurements`);
  }
  if (lot.salt.length !== 32) throw new Error('Lot salt must be 32 bytes');
  return { ...state, lots: { ...state.lots, [toHex(lotId)]: lot } };
};

const requireSecret = (s: Uint8Array | undefined, name: string): Uint8Array => {
  if (!s || s.length !== 32) throw new Error(`${name} is missing or not 32 bytes`);
  return s;
};

const requireLot = (state: LotproofPrivateState, lotId: Uint8Array): PrivateLot => {
  const lot = state.lots[toHex(lotId)];
  if (!lot) throw new Error(`No private measurements for lot ${toHex(lotId)}`);
  return lot;
};

export const witnesses: Witnesses<LotproofPrivateState> = {
  adminSecret: ({ privateState }) => [privateState, requireSecret(privateState.adminSecret, 'adminSecret')],
  customerSecret: ({ privateState }) => [privateState, requireSecret(privateState.customerSecret, 'customerSecret')],
  stationSecret: ({ privateState }) => [privateState, requireSecret(privateState.stationSecret, 'stationSecret')],
  lotMeasurements: ({ privateState }, lotId) => [privateState, requireLot(privateState, lotId).values],
  lotSalt: ({ privateState }, lotId) => [privateState, requireLot(privateState, lotId).salt],
};
