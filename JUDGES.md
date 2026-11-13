# Lotproof for judges

A supplier proves to its customer how many parts of a lot sit inside the drawing tolerance, on Midnight, without handing over the measurements. This page is the short path through the project.

## Try it in three minutes

Open the live demo: **https://lotproof.avanc3.pe** (Midnight Preview, no wallet needed).

1. Pick a lot on the left. The headline gives the count inside the band and the verdict under the customer's acceptance number. In the chart, marks inside the band are identical and sit flat on the nominal line. Parts outside the band appear only as a count, with no position.
2. Click any transaction hash in **Proof trail**. It opens in the 1AM Preview explorer, where the call shows up as `commitLot()`, `proveLot()`, `disclosePart()`, `requestAudit()` or `answerAudit()`.
3. Click **Measure a new lot** (choose how many parts fall out). The station commits the measurements, then the supplier proves the count. Both are real Preview transactions, about 60 to 90 seconds in total.
4. Click **Simulate tampering**. The station commits real readings, someone swaps in better ones, and the proof is refused by the contract: `Measurements do not match the station commitment`. No count reaches the ledger.
5. Open **Supplier console** to see what only the supplier holds: the 32 raw values. Disclose one part and it moves to its real height in the customer's chart, with its value and deviation. The other 31 stay private.
6. Pick an accepted lot and click **Audit with a tighter band**. As the customer you publish a new question; the supplier proves how many parts fit 12.000 ± 0.020 mm from the commitment made at measuring time. No new measurement, no value revealed.

The demo service is rate limited to 6 chain jobs per address and 30 in total per hour, and runs one job at a time.

## What to check in the code

| Claim | Where it is enforced |
| --- | --- |
| Values cannot change after measuring | `proveLot` and `disclosePart` recompute the commitment from the private values and assert equality with the station's (`contract/lotproof.compact`) |
| A commitment opens for its own lot only | `lotCommitment` is a `persistentCommit` over a domain tag, the lot id, the spec id and the values; a test reuses one lot's values and salt to prove another and is refused |
| The customer, not the supplier, approves stations and sets the band and acceptance number | `registerStation`, `revokeStation`, `publishSpec` and `requestAudit` call `assertCustomer()`; the customer key is fixed in the constructor |
| Only an approved station can commit, and only under the spec it was approved for | `commitLot` derives the station key from a witness secret and reads its spec from `stations`; a revoked station is refused, its earlier lots stay valid |
| A later audit is answered from the sealed values | `answerAudit` recomputes the lot's commitment from the private values, then counts them against the audit spec; requests and answers are counted publicly |
| Only the supplier admin can prove or disclose | `assertAdmin()`; identities are `persistentHash` of witness secrets with domain separators, never `ownPublicKey()` |
| The supplier cannot hide a measured lot or an audit | `committedLots`, `provenLots`, `requestedAudits` and `answeredAudits` are public |
| Only the count and the verdict are public | `proveLot` discloses `inTolerance` and the status; the vector of values never leaves the witness |
| One disclosed part belongs to the committed lot | `disclosePart` only runs on a proven lot, re-checks the commitment, then picks the value with `fold`, since vectors cannot be indexed at runtime; the same part cannot be disclosed twice |
| Drawing numbers and lot labels stay off the ledger | the demo derives ids with a keyed SHA-256 (`server/chain.ts`, `asId`); the ledger only sees 32 opaque bytes |
| Band edges count as inside | `countInTolerance` uses `v >= lower && v <= upper`; the web view uses the same rule |

Tests:

```bash
yarn test:sim      # 32 simulator tests, 17 of them inputs the contract must refuse
yarn test:local    # 5 end-to-end tests with real proofs on a local devnet
yarn test:preview  # the same 5 on Midnight Preview (passed on 13 Nov 2026)
```

CI compiles the contract with Compact 0.36.0, type-checks and runs the simulator tests on every push.

## On-chain evidence (Preview)

| What | Link |
| --- | --- |
| Contract | [8ae9c803…fcad9128](https://explorer.1am.xyz/contract/8ae9c803faa306226eb3203b57f4b48d6f75b797a1aadf02c025b66dfcad9128?network=preview) |
| Deploy, with the customer key in the constructor | [0515b8a3…4d34cfbe](https://explorer.1am.xyz/tx/0515b8a3a5ce9d9781303803add639458791b040ce9c93fcf789a6304d34cfbe?network=preview) |
| Customer publishes the spec | [a489e60f…ba4a5552](https://explorer.1am.xyz/tx/a489e60fd797d93d97526f42a1f128abb4ab70a07602062583461a01ba4a5552?network=preview), block 98105 |
| Customer approves the station for that spec | [8767422d…a9dbf3ae](https://explorer.1am.xyz/tx/8767422da213ef3f28d21ccead3e59684757e5d38e1eafe7d70d6b5ea9dbf3ae?network=preview), block 98110 |
| Customer publishes the audit band, 12.000 ± 0.020 mm | [917c72d1…e8125804](https://explorer.1am.xyz/tx/917c72d11d4a0b29caf5eb57635cf47b9c347ff37154532cce4a22dae8125804?network=preview), block 98115 |
| LOT-261113-001 committed, then proven 31 of 32 inside, accepted | [ba56d422…068996fb](https://explorer.1am.xyz/tx/ba56d4228018c5d01626a47ea95d58549ddcf3a728291153860a171e068996fb?network=preview), block 98124; [040c279b…a2b4865b](https://explorer.1am.xyz/tx/040c279b3a1bd9001869e3ea74b9b66104c445b889f133f7c1f472fda2b4865b?network=preview), block 98130 |
| Customer requests an audit of LOT-261113-001 | [66692415…a7a43107](https://explorer.1am.xyz/tx/6669241561c3d3b10aa3108022a321f58e3f831dd991c2d0dc035714a7a43107?network=preview), block 98159 |
| Supplier answers from the same commitment: 17 of 32 inside the audit band | [40a0aa77…aec9ac3b](https://explorer.1am.xyz/tx/40a0aa77c9780cf03809a27a013258fd7f44d81af56120d19d9a758baec9ac3b?network=preview), block 98167 |
| LOT-261113-002 committed, then proven 30 of 32 inside, rejected | [e3854993…57a1688b](https://explorer.1am.xyz/tx/e3854993998160700389ecc8bc8db3d3f4a4088e3dab0b252a214e7057a1688b?network=preview), block 98136; [3aed6138…3be8a22e](https://explorer.1am.xyz/tx/3aed613850d78d7c7b2ede6bc55e67ff22b09a9ab6a14ef616c9eb883be8a22e?network=preview), block 98142 |
| Part #9 of LOT-261113-002 disclosed, 11.935 mm | [a8cda66f…9a02f41e](https://explorer.1am.xyz/tx/a8cda66fb1a78c0c290fce26ad4418d54500e06fd9b1f42cdd68d66b9a02f41e?network=preview), block 98154 |
| LOT-261113-003 committed, then the tampered proof refused (no transaction) | [6920f019…67b03fb5](https://explorer.1am.xyz/tx/6920f0193057369dea18f894fd6918369af52560ff173794643fb03967b03fb5?network=preview), block 98148 |

The end-to-end suite also ran on Preview against its own contract on 13 Nov 2026: 5 of 5 passed, 12 transactions, including a rejected lot, a disclosure and an audit.

Lot labels appear here and in the demo because the demo plays both parties. On the ledger the lots are keyed hashes.

## Trust model and limits

- **The measuring station is the root of trust.** Lotproof proves that the published count matches what the station committed at measuring time. It does not prove that the station measured correctly; that stays with calibration and audits, as today.
- **The station still sits in the supplier's plant.** The customer approves its key and can revoke it, but a supplier that controls the station's secret could commit made-up numbers. Binding the key to the instrument (secure element, calibration certificate) is the next step.
- **In the demo one service plays all three roles** (customer, supplier admin and station) with one wallet, and the measurements are simulated CMM readings. In a real deployment each secret lives on its owner's machine.
- **The count and the verdict are public**, readable by anyone, not only the customer. That is the point of the proof; who the parties are stays behind keyed ids.
- **One characteristic per drawing** (a diameter) and **a fixed sample of 32 parts**, because Compact vectors have a static length.
- The supplier console is shown so judges can see both sides. In production that data never leaves the supplier's network.

## Built in this wave

Everything here was written during Midnight Buildathon Wave 3 (November 2026). Wallet and provider wiring is adapted from `midnightntwrk/example-hello-world` (Apache-2.0).
