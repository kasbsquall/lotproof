# Lotproof for judges

A supplier proves to its customer how many parts of a lot sit inside the drawing tolerance, on Midnight, without handing over the measurements. This page is the short path through the project.

## Try it in three minutes

Open the live demo: **https://lotproof.154-53-53-223.sslip.io** (Midnight Preview, no wallet needed).

1. Pick a lot on the left. The headline gives the count inside the band and the verdict under the customer's acceptance number. In the chart, marks inside the band are identical and sit flat on the nominal line. Parts outside the band appear only as a count, with no position.
2. Click any transaction hash in **Proof trail**. It opens in the 1AM Preview explorer, where the call shows up as `commitLot()`, `proveLot()` or `disclosePart()`.
3. Click **Measure a new lot** (choose how many parts fall out). The station commits the measurements, then the supplier proves the count. Both are real Preview transactions, about 60 to 90 seconds in total.
4. Click **Try to change the numbers**. The station commits real readings, someone swaps in better ones, and the proof is refused by the contract: `Measurements do not match the station commitment`. No count reaches the ledger.
5. Open **Supplier console** to see what only the supplier holds: the 32 raw values. Disclose one part and it moves to its real height in the customer's chart, with its value and deviation. The other 31 stay private.

The demo service is rate limited to 6 chain jobs per address per hour, and runs one job at a time.

## What to check in the code

| Claim | Where it is enforced |
| --- | --- |
| Values cannot change after measuring | `proveLot` and `disclosePart` recompute the commitment from the private values and assert equality with the station's (`contract/lotproof.compact`) |
| A commitment opens for its own lot only | `lotCommitment` is a `persistentCommit` over a domain tag, the lot id, the spec id and the values; a test reuses one lot's values and salt to prove another and is refused |
| The customer, not the supplier, approves stations and sets the band and acceptance number | `registerStation`, `revokeStation` and `publishSpec` call `assertCustomer()`; the customer key is fixed in the constructor |
| Only an approved station can commit | `commitLot` derives the station key from a witness secret and checks `stations.member`; a revoked station is refused, its earlier lots stay valid |
| Only the supplier admin can prove or disclose | `assertAdmin()`; identities are `persistentHash` of witness secrets with domain separators, never `ownPublicKey()` |
| The supplier cannot hide a measured lot | `committedLots` and `provenLots` are public; their difference is the number of lots measured and not proven |
| Only the count and the verdict are public | `proveLot` discloses `inTolerance` and the status; the vector of values never leaves the witness |
| One disclosed part belongs to the committed lot | `disclosePart` re-checks the commitment, then picks the value with `fold`, since vectors cannot be indexed at runtime; the same part cannot be disclosed twice |
| Drawing numbers and lot labels stay off the ledger | the demo derives ids with a keyed SHA-256 (`server/chain.ts`, `asId`); the ledger only sees 32 opaque bytes |
| Band edges count as inside | `countInTolerance` uses `v >= lower && v <= upper`; the web view uses the same rule |

Tests:

```bash
yarn test:sim      # 25 simulator tests, 14 of them inputs the contract must refuse
yarn test:local    # 4 end-to-end tests with real proofs on a local devnet
```

CI compiles the contract with Compact 0.36.0, type-checks and runs the simulator tests on every push.

## On-chain evidence (Preview)

| What | Link |
| --- | --- |
| Contract | [71e8f660…e8e3324f](https://explorer.1am.xyz/contract/71e8f660aab5109d51842db8dbf3521cb3fb86ab4ffa4cd802270dd3e8e3324f?network=preview) |
| Deploy, with the customer key in the constructor | [0d32401c…6840ade0](https://explorer.1am.xyz/tx/0d32401c0ef60310b309321123ef391ca4c8e08af347b6bbcda5fa7b6840ade0?network=preview) |
| Customer approves the station | [13180b42…eb3b6980](https://explorer.1am.xyz/tx/13180b426a7d5257fd07944968bf2875e61af2bc1294e2d9caec2ab5eb3b6980?network=preview), block 96051 |
| Customer publishes the spec | [ec721c18…c0269fa1](https://explorer.1am.xyz/tx/ec721c18a1e8781bcb6d2d3d3833a601cc1be4489fed3530eeefb046c0269fa1?network=preview), block 96056 |
| Lot LOT-261113-001 committed, then proven 31 of 32 inside, accepted | [b03e50c4…bc4fa92e](https://explorer.1am.xyz/tx/b03e50c41c7358664940b31ef84610f2afd388c65f1f59c708cd3680bc4fa92e?network=preview), block 96066; [1b7f5777…9aa3f440](https://explorer.1am.xyz/tx/1b7f577760a36c116962988a24dd210442b6bd9bcc950a64000b67869aa3f440?network=preview), block 96072 |
| Lot LOT-261113-002 committed | [51f0cbad…94ff0b51](https://explorer.1am.xyz/tx/51f0cbadba3e95c61513a4fd47cb3d8412ed133c3bddd3afcda9d3b894ff0b51?network=preview), block 96078 |
| Lot LOT-261113-002 proven, 30 of 32 inside, rejected | [a8bf5484…24112a69](https://explorer.1am.xyz/tx/a8bf5484111565da5d7052e19846e8664eeec5b9786407da610dee2224112a69?network=preview), block 96084 |
| Part #4 of LOT-261113-002 disclosed, 12.068 mm | [94617211…28d15bce](https://explorer.1am.xyz/tx/946172111f6c4194520ef345d19cc49324ef60d8195b81d0c5f75bea28d15bce?network=preview), block 96096 |
| Lot LOT-261113-003 committed, then the tampered proof refused (no transaction) | [234cafb3…cd21ffc8](https://explorer.1am.xyz/tx/234cafb3b9c4f79cd40b614f13cba204ae54d837800ed3f1b1e22857cd21ffc8?network=preview), block 96090 |

Lot labels appear here and in the demo because the demo plays both parties. On the ledger the lots are keyed hashes, for example `96753159…a155d690` for LOT-261113-002.

## Trust model and limits

- **The measuring station is the root of trust.** Lotproof proves that the published count matches what the station committed at measuring time. It does not prove that the station measured correctly; that stays with calibration and audits, as today.
- **The station still sits in the supplier's plant.** The customer approves its key and can revoke it, but a supplier that controls the station's secret could commit made-up numbers. Binding the key to the instrument (secure element, calibration certificate) is the next step.
- **In the demo one service plays all three roles** (customer, supplier admin and station) with one wallet, and the measurements are simulated CMM readings. In a real deployment each secret lives on its owner's machine.
- **The count and the verdict are public**, readable by anyone, not only the customer. That is the point of the proof; who the parties are stays behind keyed ids.
- **One characteristic per drawing** (a diameter) and **a fixed sample of 32 parts**, because Compact vectors have a static length.
- The supplier console is shown so judges can see both sides. In production that data never leaves the supplier's network.

## Built in this wave

Everything here was written during Midnight Buildathon Wave 3 (November 2026). Wallet and provider wiring is adapted from `midnightntwrk/example-hello-world` (Apache-2.0).
