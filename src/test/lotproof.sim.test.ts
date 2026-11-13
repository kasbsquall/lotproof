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
    await sim.publishSpec(SPEC_ID, SHAFT);
    await sim.registerStation(sim.stationKey(), SPEC_ID);
  });

  describe('happy path', () => {
    it('accepts a lot with every part inside the band and publishes only the count', async () => {
      const lot = idFrom('LOT-2026-1109-A');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot);
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
        await sim.commitLot(id);
      }
      const l = await sim.proveLot(a);
      expect(l.committedLots).toBe(2n);
      expect(l.provenLots).toBe(1n);
      expect(l.lots.lookup(b).status).toBe(LotStatus.Committed);
    });

    it('accepts a lot at exactly the acceptance number (31 of 32)', async () => {
      const lot = idFrom('LOT-B');
      sim.measure(lot, { values: withOutliers(1), salt: bytes32() });
      await sim.commitLot(lot);
      const rec = (await sim.proveLot(lot)).lots.lookup(lot);
      expect(rec.inTolerance).toBe(31n);
      expect(rec.status).toBe(LotStatus.Accepted);
    });

    it('rejects a lot above the acceptance number (30 of 32) and says so on chain', async () => {
      const lot = idFrom('LOT-C');
      sim.measure(lot, { values: withOutliers(2), salt: bytes32() });
      await sim.commitLot(lot);
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
      await sim.commitLot(lot);
      expect((await sim.proveLot(lot)).lots.lookup(lot).inTolerance).toBe(32n);
    });

    it('stores only the salted commitment at measuring time', async () => {
      const lot = idFrom('LOT-D');
      const values = goodValues();
      const salt = bytes32();
      sim.measure(lot, { values, salt });
      const rec = (await sim.commitLot(lot)).lots.lookup(lot);
      expect(rec.status).toBe(LotStatus.Committed);
      expect(rec.commitment).toEqual(pureCircuits.lotCommitment(lot, SPEC_ID, values, salt));
      expect(rec.station).toEqual(sim.stationKey());
    });

    it('discloses one disputed part and keeps the other 31 private', async () => {
      const lot = idFrom('LOT-E');
      const values = goodValues();
      sim.measure(lot, { values, salt: bytes32() });
      await sim.commitLot(lot);
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
      await sim.commitLot(lot);
      // The supplier swaps in "better" numbers before proving.
      sim.measure(lot, { values: goodValues(), salt });
      await expect(sim.proveLot(lot)).rejects.toThrow(/do not match the station commitment/);
    });

    it('rejects a disclosed value that is not the committed one', async () => {
      const lot = idFrom('LOT-LIE');
      const salt = bytes32();
      sim.measure(lot, { values: withOutliers(1), salt });
      await sim.commitLot(lot);
      await sim.proveLot(lot);
      sim.measure(lot, { values: goodValues(), salt });
      await expect(sim.disclosePart(lot, 0n)).rejects.toThrow(/do not match the station commitment/);
    });

    it('rejects a commitment from an unregistered station', async () => {
      const lot = idFrom('LOT-ROGUE');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      sim.impersonate({ stationSecret: bytes32() });
      await expect(sim.commitLot(lot)).rejects.toThrow(/Station not registered/);
    });

    it('rejects proving by anyone other than the supplier admin', async () => {
      const lot = idFrom('LOT-OUTSIDER');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot);
      sim.impersonate({ adminSecret: bytes32() });
      await expect(sim.proveLot(lot)).rejects.toThrow(/Only the supplier admin/);
    });

    it('lets only the customer approve stations and publish specs, not the supplier', async () => {
      // The supplier keeps its admin secret but does not hold the customer's.
      sim.impersonate({ customerSecret: bytes32() });
      await expect(sim.registerStation(bytes32(), SPEC_ID)).rejects.toThrow(/Only the customer/);
      await expect(sim.revokeStation(sim.stationKey())).rejects.toThrow(/Only the customer/);
      await expect(sim.publishSpec(idFrom('X'), SHAFT)).rejects.toThrow(/Only the customer/);
    });

    it('rejects approving the same station twice and revoking an unknown one', async () => {
      await expect(sim.registerStation(sim.stationKey(), SPEC_ID)).rejects.toThrow(/already approved/);
      await expect(sim.registerStation(bytes32(), idFrom('NO-SUCH-SPEC'))).rejects.toThrow(/Unknown spec/);
      await expect(sim.revokeStation(bytes32())).rejects.toThrow(/Station not registered/);
    });

    it('refuses new lots from a revoked station but keeps the lots it already committed', async () => {
      const before = idFrom('LOT-BEFORE');
      sim.measure(before, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(before);
      const l = await sim.revokeStation(sim.stationKey());
      expect(l.stations.member(sim.stationKey())).toBe(false);
      const after = idFrom('LOT-AFTER');
      sim.measure(after, { values: goodValues(), salt: bytes32() });
      await expect(sim.commitLot(after)).rejects.toThrow(/Station not registered/);
      expect((await sim.proveLot(before)).lots.lookup(before).status).toBe(LotStatus.Accepted);
    });

    it('binds each on-chain commitment to its lot: same values and salt give different commitments', async () => {
      const a = idFrom('LOT-A');
      const b = idFrom('LOT-B2');
      const values = goodValues();
      const salt = bytes32();
      sim.measure(a, { values, salt });
      sim.measure(b, { values, salt });
      await sim.commitLot(a);
      const l = await sim.commitLot(b);
      expect(l.lots.lookup(a).commitment).not.toEqual(l.lots.lookup(b).commitment);
    });

    it('commits a lot under the spec the customer approved the station for', async () => {
      const wide = idFrom('DRW-WIDE');
      await sim.publishSpec(wide, { ...SHAFT, lower: 11_000n, upper: 13_000n });
      const lot = idFrom('LOT-SPEC');
      sim.measure(lot, { values: withOutliers(3), salt: bytes32() });
      const rec = (await sim.commitLot(lot)).lots.lookup(lot);
      expect(rec.specId).toEqual(SPEC_ID);
      // Proven against the tight band, not the wide one: 3 out, rejected.
      expect((await sim.proveLot(lot)).lots.lookup(lot).status).toBe(LotStatus.Rejected);
    });

    it('rejects committing the same lot twice', async () => {
      const lot = idFrom('LOT-TWICE');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot);
      await expect(sim.commitLot(lot)).rejects.toThrow(/already committed/);
    });

    it('rejects proving a lot twice', async () => {
      const lot = idFrom('LOT-REPROVE');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot);
      await sim.proveLot(lot);
      await expect(sim.proveLot(lot)).rejects.toThrow(/already proven/);
    });

    it('rejects proving an unknown lot', async () => {
      await expect(sim.proveLot(idFrom('GHOST'))).rejects.toThrow(/Unknown lot/);
    });

    it('refuses to disclose a part of a lot that is not proven yet', async () => {
      const lot = idFrom('LOT-EARLY');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot);
      await expect(sim.disclosePart(lot, 0n)).rejects.toThrow(/not proven yet/);
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
      await sim.commitLot(lot);
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
      await sim.commitLot(lot);
      await expect(sim.disclosePart(lot, 32n)).rejects.toThrow(/out of range/);
    });
  });

  describe('audits asked after the fact', () => {
    // Tighter band published by the customer later: 12.000 +/- 0.020 mm.
    const AUDIT_ID = idFrom('AUDIT-2026-Q4');
    const TIGHT: Spec = { nominal: 12_000n, lower: 11_980n, upper: 12_020n, maxDefects: 0n };

    it('answers a customer audit against a new band from the same commitment, without new measurements', async () => {
      const lot = idFrom('LOT-AUDIT');
      const values = goodValues();
      sim.measure(lot, { values, salt: bytes32() });
      await sim.commitLot(lot);
      await sim.proveLot(lot);
      await sim.publishSpec(AUDIT_ID, TIGHT);
      let l = await sim.requestAudit(lot, AUDIT_ID);
      const key = pureCircuits.auditKey(lot, AUDIT_ID);
      expect(l.audits.lookup(key).answered).toBe(false);
      expect(l.requestedAudits - l.answeredAudits).toBe(1n);
      l = await sim.answerAudit(lot, AUDIT_ID);
      const expected = BigInt(values.filter((v) => v >= TIGHT.lower && v <= TIGHT.upper).length);
      expect(l.audits.lookup(key)).toMatchObject({ answered: true, inTolerance: expected });
      expect(l.requestedAudits - l.answeredAudits).toBe(0n);
      expect(l.lots.lookup(lot).inTolerance).toBe(32n);
      expect(l.disclosed.member(lot)).toBe(false);
    });

    it('lets only the customer request and only the supplier answer, once', async () => {
      const lot = idFrom('LOT-AUDIT-2');
      sim.measure(lot, { values: goodValues(), salt: bytes32() });
      await sim.commitLot(lot);
      await sim.publishSpec(AUDIT_ID, TIGHT);
      await expect(sim.answerAudit(lot, AUDIT_ID)).rejects.toThrow(/No audit requested/);
      const customer = sim.privateState.customerSecret;
      sim.impersonate({ customerSecret: bytes32() });
      await expect(sim.requestAudit(lot, AUDIT_ID)).rejects.toThrow(/Only the customer/);
      sim.impersonate({ customerSecret: customer });
      await sim.requestAudit(lot, AUDIT_ID);
      await expect(sim.requestAudit(lot, AUDIT_ID)).rejects.toThrow(/already requested/);
      const admin = sim.privateState.adminSecret;
      sim.impersonate({ adminSecret: bytes32() });
      await expect(sim.answerAudit(lot, AUDIT_ID)).rejects.toThrow(/Only the supplier admin/);
      sim.impersonate({ adminSecret: admin });
      await sim.answerAudit(lot, AUDIT_ID);
      await expect(sim.answerAudit(lot, AUDIT_ID)).rejects.toThrow(/already answered/);
    });

    it('refuses an audit answer from changed measurements, and audits of unknown lots or specs', async () => {
      const lot = idFrom('LOT-AUDIT-3');
      const salt = bytes32();
      sim.measure(lot, { values: withOutliers(2), salt });
      await sim.commitLot(lot);
      await sim.publishSpec(AUDIT_ID, TIGHT);
      await expect(sim.requestAudit(idFrom('GHOST'), AUDIT_ID)).rejects.toThrow(/Unknown lot/);
      await expect(sim.requestAudit(lot, idFrom('NO-SPEC'))).rejects.toThrow(/Unknown spec/);
      await sim.requestAudit(lot, AUDIT_ID);
      sim.measure(lot, { values: goodValues(), salt });
      await expect(sim.answerAudit(lot, AUDIT_ID)).rejects.toThrow(/do not match the station commitment/);
    });
  });

  describe('edge cases', () => {
    it('handles a zero acceptance number and a zero-width band', async () => {
      const zero = idFrom('DRW-ZERO');
      await sim.publishSpec(zero, { nominal: 12_000n, lower: 12_000n, upper: 12_000n, maxDefects: 0n });
      const lot = idFrom('LOT-ZERO');
      const v = goodValues();
      v[0] = 12_000n;
      sim.measure(lot, { values: v, salt: bytes32() });
      await sim.commitLot(lot);
      await sim.proveLot(lot);
      await sim.requestAudit(lot, zero);
      const l = await sim.answerAudit(lot, zero);
      expect(l.audits.lookup(pureCircuits.auditKey(lot, zero)).inTolerance).toBe(
        BigInt(v.filter((x) => x === 12_000n).length),
      );
    });

    it('rejects a spec whose nominal sits below the band', async () => {
      await expect(sim.publishSpec(idFrom('BAD-LOW'), { ...SHAFT, nominal: 11_900n })).rejects.toThrow(/inside the band/);
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
