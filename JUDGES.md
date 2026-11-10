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
| Values cannot change after measuring | `proveLot` and `disclosePart` re-hash the private values with the salt and assert equality with the station's commitment (`contract/lotproof.compact`) |
| Only a registered station can commit | `commitLot` derives the station key from a witness secret and checks `stations.member` |
| Only the supplier admin can prove or disclose | `assertAdmin()`; identities are `persistentHash` of witness secrets with domain separators, never `ownPublicKey()` |
| Only the count and the verdict are public | `proveLot` discloses `inTolerance` and the status; the vector of values never leaves the witness |
| One disclosed part belongs to the committed lot | `disclosePart` re-checks the commitment, then picks the value with `fold`, since vectors cannot be indexed at runtime |
| Band edges count as inside | `countInTolerance` uses `v >= lower && v <= upper`; the web view uses the same rule |

Tests:

```bash
yarn test:sim      # 19 simulator tests, 10 of them inputs the contract must refuse
yarn test:local    # 4 end-to-end tests with real proofs on a local devnet
```

CI compiles the contract with Compact 0.36.0, type-checks and runs the simulator tests on every push.

## On-chain evidence (Preview)

| What | Link |
| --- | --- |
| Contract | [e74b37e7…0ae5eb49](https://explorer.1am.xyz/contract/e74b37e7ef6ad0e850bb1b110b9f8bea2f222c2c6700a9bb02fdd3740ae5eb49?network=preview) |
| Deploy | [67b9aaef…1c78fbf8](https://explorer.1am.xyz/tx/67b9aaefb4317a1cd9c48ae9d6ad105f96a4e166c0def1aa79cbfbae1c78fbf8?network=preview) |
| Register station | [d737e0ba…c3e71f75](https://explorer.1am.xyz/tx/d737e0ba432c9c920830d1c08ea2d6c411782c6b599624662f22b1cfc3e71f75?network=preview) |
| Publish spec DRW-4471-rev-C | [56f520ef…7b8d7251](https://explorer.1am.xyz/tx/56f520ef81cc8bd3e2ed05930c4ef4708ce0d45a48e173563791a4fa7b8d7251?network=preview) |
| Lot committed (LOT-261110-002) | [6aec5c68…4043b873](https://explorer.1am.xyz/tx/6aec5c68b7a522955cd2ce306e9a00a70590ef8396b487e52caee1884043b873?network=preview), block 47049 |
| Lot proven, 30 of 32 inside, rejected | [d5fbf036…222f151d](https://explorer.1am.xyz/tx/d5fbf036da990bff58f42b96b638bb63fffdedc1b933f249c6e42c2e222f151d?network=preview), block 47055 |
| Part #19 disclosed, 11.945 mm | [444afb25…97931c95](https://explorer.1am.xyz/tx/444afb25fefcf1ac5e88535e02ecc3d98356917dc08877cfe3aade8e97931c95?network=preview), block 47240 |

## Trust model and limits

- **The measuring station is the root of trust.** Lotproof proves that the published count matches what the station committed at measuring time. It does not prove that the station measured correctly; that stays with calibration and audits, as today.
- **In the demo one service plays every supplier role** (admin, station and private state) with one wallet, and the measurements are simulated CMM readings. In a real plant the station secret would live on the measuring machine.
- **One characteristic per drawing** (a diameter) and **a fixed sample of 32 parts**, because Compact vectors have a static length.
- The supplier console is shown so judges can see both sides. In production that data never leaves the supplier's network.

## Built in this wave

Everything here was written during Midnight Buildathon Wave 3 (November 2026). Wallet and provider wiring is adapted from `midnightntwrk/example-hello-world` (Apache-2.0).
