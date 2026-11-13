// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { LotStatus, pureCircuits, type Spec } from '../../contract/index.js';
import { LotproofSimulator, bytes32, idFrom } from './lotproof.simulator.js';


// Shaft diameter 12.000 mm +/- 0.050 mm, customer accepts at most 1 defect in 32.
const SHAFT: Spec = { nominal: 12_000n, lower: 11_950n, upper: 12_050n, maxDefects: 1n };
const SPEC_ID = idFrom('DRW-4471-rev-C');

/** 32 readings around nominal, all inside the band. */
const goodValues = (): bigint[] => Array.from({ length: 32 }, (_, i) => 11_970n + BigInt((i * 7) % 60));

const withOutliers = (n: number): bigint[] => {
  const v = goodValues();
  for (let i = 0; i < n; i++) v[i * 3] = 12_080n + BigInt(i);
  return v;
};

describe('Lotproof contract (simulator)', () => {
  let sim: LotproofSimulator;

  beforeEach(async () => {
    sim = await LotproofSimulator.create();
    await sim.registerStation(sim.stationKey());
    await sim.publishSpec(SPEC_ID, SHAFT);
  });

  describe('happy path', () => {
    it('accepts a lot with every part inside the band and publishes only the count', async () => {
      const lot = idFrom('LOT-2026-1109-A');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      const l = await sim.proveLot(lot);
      const rec = l.lots.lookup(lot);
      expect(rec.status).toBe(LotStatus.Accepted);
      expect(rec.inTolerance).toBe(32n);
      expect(l.provenLots).toBe(1n);
      expect(l.disclosed.member(lot)).toBe(false);
    });

    it('fixes the customer at deployment and shows lots committed but not yet proven', async () => {
      const l0 = sim.getLedger();
      expect(l0.customer).toEqual(pureCircuits.customerKey(sim.privateState.customerSecret));
      expect(l0.customer).not.toEqual(l0.admin);
      const [a, b] = [idFrom('LOT-P1'), idFrom('LOT-P2')];
      for (const id of [a, b]) {
        sim.measure(id, { values: goodValues(), salt: bytes32() });
        await sim.commitLot(id, SPEC_ID);
      }
      const l = await sim.proveLot(a);
      expect(l.committedLots).toBe(2n);
      expect(l.provenLots).toBe(1n);
      expect(l.lots.lookup(b).status).toBe(LotStatus.Committed);
    });

    it('accepts a lot at exactly the acceptance number (31 of 32)', async () => {
      const lot = idFrom('LOT-B');
      sim.measure(lot, { values: withOutliers(1), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      const rec = (await sim.proveLot(lot)).lots.lookup(lot);
      expect(rec.inTolerance).toBe(31n);
      expect(rec.status).toBe(LotStatus.Accepted);
    });

    it('rejects a lot above the acceptance number (30 of 32) and says so on chain', async () => {
      const lot = idFrom('LOT-C');
      sim.measure(lot, { values: withOutliers(2), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      const rec = (await sim.proveLot(lot)).lots.lookup(lot);
      expect(rec.inTolerance).toBe(30n);
      expect(rec.status).toBe(LotStatus.Rejected);
    });

    it('treats the band edges as inside', async () => {
      const lot = idFrom('LOT-EDGE');
      const v = goodValues();
      v[0] = SHAFT.lower;
      v[1] = SHAFT.upper;
      sim.measure(lot, { values: v, salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      expect((await sim.proveLot(lot)).lots.lookup(lot).inTolerance).toBe(32n);
    });

    it('stores only the salted commitment at measuring time', async () => {
      const lot = idFrom('LOT-D');
      const values = goodValues();
      const salt = bytes32();
      sim.measure(lot, { values, salt });
      const rec = (await sim.commitLot(lot, SPEC_ID)).lots.lookup(lot);
      expect(rec.status).toBe(LotStatus.Committed);
      expect(rec.commitment).toEqual(pureCircuits.lotCommitment(lot, SPEC_ID, values, salt));
      expect(rec.station).toEqual(sim.stationKey());
    });

    it('discloses one disputed part and keeps the other 31 private', async () => {
      const lot = idFrom('LOT-E');
      const values = goodValues();
      sim.measure(lot, { values, salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      await sim.proveLot(lot);
      const l = await sim.disclosePart(lot, 7n);
      const parts = l.disclosed.lookup(lot);
      expect(parts.lookup(7n)).toBe(values[7]);
      expect(parts.size()).toBe(1n);
    });
  });

  describe('what the contract refuses', () => {
    it('rejects measurements changed after the station committed them', async () => {
      const lot = idFrom('LOT-TAMPER');
      const salt = bytes32();
      sim.measure(lot, { values: withOutliers(3), salt });
      await sim.commitLot(lot, SPEC_ID);
      // The supplier swaps in "better" numbers before proving.
      sim.measure(lot, { values: goodValues(), salt });
      await expect(sim.proveLot(lot)).rejects.toThrow(/do not match the station commitment/);
    });

    it('rejects a disclosed value that is not the committed one', async () => {
      const lot = idFrom('LOT-LIE');
      const salt = bytes32();
      sim.measure(lot, { values: withOutliers(1), salt });
      await sim.commitLot(lot, SPEC_ID);
      sim.measure(lot, { values: goodValues(), salt });
      await expect(sim.disclosePart(lot, 0n)).rejects.toThrow(/do not match the station commitment/);
    });

    it('rejects a commitment from an unregistered station', async () => {
      const lot = idFrom('LOT-ROGUE');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      sim.impersonate({ stationSecret: bytes32() });
      await expect(sim.commitLot(lot, SPEC_ID)).rejects.toThrow(/Station not registered/);
    });

    it('rejects proving by anyone other than the supplier admin', async () => {
      const lot = idFrom('LOT-OUTSIDER');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      sim.impersonate({ adminSecret: bytes32() });
      await expect(sim.proveLot(lot)).rejects.toThrow(/Only the supplier admin/);
    });

    it('lets only the customer approve stations and publish specs, not the supplier', async () => {
      // The supplier keeps its admin secret but does not hold the customer's.
      sim.impersonate({ customerSecret: bytes32() });
      await expect(sim.registerStation(bytes32())).rejects.toThrow(/Only the customer/);
      await expect(sim.revokeStation(sim.stationKey())).rejects.toThrow(/Only the customer/);
      await expect(sim.publishSpec(idFrom('X'), SHAFT)).rejects.toThrow(/Only the customer/);
    });

    it('rejects approving the same station twice and revoking an unknown one', async () => {
      await expect(sim.registerStation(sim.stationKey())).rejects.toThrow(/already approved/);
      await expect(sim.revokeStation(bytes32())).rejects.toThrow(/Station not registered/);
    });

    it('refuses new lots from a revoked station but keeps the lots it already committed', async () => {
      const before = idFrom('LOT-BEFORE');
      sim.measure(before, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(before, SPEC_ID);
      const l = await sim.revokeStation(sim.stationKey());
      expect(l.stations.member(sim.stationKey())).toBe(false);
      const after = idFrom('LOT-AFTER');
      sim.measure(after, { values: goodValues(), salt: bytes32() });
      await expect(sim.commitLot(after, SPEC_ID)).rejects.toThrow(/Station not registered/);
      expect((await sim.proveLot(before)).lots.lookup(before).status).toBe(LotStatus.Accepted);
    });

    it("refuses to reuse one lot's measurements and salt to prove another lot", async () => {
      const a = idFrom('LOT-A');
      const b = idFrom('LOT-B2');
      const salt = bytes32();
      sim.measure(a, { values: withOutliers(3), salt });
      sim.measure(b, { values: goodValues(), salt });
      await sim.commitLot(a, SPEC_ID);
      await sim.commitLot(b, SPEC_ID);
      // The supplier tries to prove the bad lot with the good lot's numbers and salt.
      sim.measure(a, { values: goodValues(), salt });
      await expect(sim.proveLot(a)).rejects.toThrow(/do not match the station commitment/);
    });

    it('rejects committing the same lot twice', async () => {
      const lot = idFrom('LOT-TWICE');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      await expect(sim.commitLot(lot, SPEC_ID)).rejects.toThrow(/already committed/);
    });

    it('rejects proving a lot twice', async () => {
      const lot = idFrom('LOT-REPROVE');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      await sim.proveLot(lot);
      await expect(sim.proveLot(lot)).rejects.toThrow(/already proven/);
    });

    it('rejects a lot against an unknown spec and an unknown lot', async () => {
      const lot = idFrom('LOT-NOSPEC');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await expect(sim.commitLot(lot, idFrom('NOPE'))).rejects.toThrow(/Unknown spec/);
      await expect(sim.proveLot(idFrom('GHOST'))).rejects.toThrow(/Unknown lot/);
    });

    it('rejects specs that are malformed or reuse an id', async () => {
      await expect(sim.publishSpec(SPEC_ID, SHAFT)).rejects.toThrow(/already used/);
      await expect(
        sim.publishSpec(idFrom('BAD-BAND'), { ...SHAFT, nominal: 13_000n }),
      ).rejects.toThrow(/inside the band/);
      await expect(
        sim.publishSpec(idFrom('BAD-AQL'), { ...SHAFT, maxDefects: 33n }),
      ).rejects.toThrow(/larger than the sample/);
    });

    it('rejects disclosure by anyone other than the supplier, of an unknown lot, or of the same part twice', async () => {
      const lot = idFrom('LOT-DISPUTE');
      sim.measure(lot, { values: withOutliers(1), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      await sim.proveLot(lot);
      await expect(sim.disclosePart(idFrom('GHOST'), 0n)).rejects.toThrow(/Unknown lot/);
      await sim.disclosePart(lot, 0n);
      await expect(sim.disclosePart(lot, 0n)).rejects.toThrow(/already disclosed/);
      const admin = sim.privateState.adminSecret;
      sim.impersonate({ adminSecret: bytes32() });
      await expect(sim.disclosePart(lot, 1n)).rejects.toThrow(/Only the supplier admin/);
      sim.impersonate({ adminSecret: admin });
      expect((await sim.disclosePart(lot, 1n)).disclosed.lookup(lot).size()).toBe(2n);
    });

    it('rejects an out-of-range part index', async () => {
      const lot = idFrom('LOT-IDX');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot, SPEC_ID);
      await expect(sim.disclosePart(lot, 32n)).rejects.toThrow(/out of range/);
    });
  });

  describe('pure circuits', () => {
    it('counts parts inside the band', () => {
      expect(pureCircuits.countInTolerance(withOutliers(4), SHAFT.lower, SHAFT.upper)).toBe(28n);
    });
    it('picks the part at a runtime index', () => {
      const v = goodValues();
      expect(pureCircuits.pickPart(v, 31n)).toBe(v[31]);
    });
    it('hides equal values behind different salts', () => {
      const v = goodValues();
      const lot = idFrom('LOT-H');
      expect(pureCircuits.lotCommitment(lot, SPEC_ID, v, bytes32())).not.toEqual(
        pureCircuits.lotCommitment(lot, SPEC_ID, v, bytes32()),
      );
    });
    it('binds the commitment to its lot and its spec', () => {
      const v = goodValues();
      const salt = bytes32();
      const base = pureCircuits.lotCommitment(idFrom('LOT-1'), SPEC_ID, v, salt);
      expect(pureCircuits.lotCommitment(idFrom('LOT-2'), SPEC_ID, v, salt)).not.toEqual(base);
      expect(pureCircuits.lotCommitment(idFrom('LOT-1'), idFrom('DRW-OTHER'), v, salt)).not.toEqual(base);
    });
  });
});
