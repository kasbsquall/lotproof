# Lotproof

[![ci](https://github.com/kasbsquall/lotproof/actions/workflows/ci.yml/badge.svg)](https://github.com/kasbsquall/lotproof/actions/workflows/ci.yml)

**A parts supplier proves a lot is inside the drawing tolerance without handing over its measurements.**

Customers ask suppliers for the raw measurements of every lot before they accept it. Those numbers describe the supplier's process, and suppliers know they end up in the next price negotiation ("[Contract manufacturers] are leery of sharing information that could lead to demands for more price cuts", Matt Littlefield, LNS Research, quoted by SAP). Lotproof gives both sides a third option between "send me everything" and "trust my certificate".

**In plain words.** A *lot* is a batch of parts made together. The customer's drawing sets a *tolerance band* (the range every part must fall in) and an *acceptance number* (how many parts may fall outside before the lot is rejected). The parts are measured on a *CMM*, a coordinate measuring machine.

**Example, live on Midnight Preview.** The drawing says a diameter of 12.000 mm ± 0.050, and the lot is accepted if at most 1 part of 32 falls outside. Lot LOT-261110-002 was measured, and the customer saw **"30 of 32 inside, rejected"** ([proof transaction](https://explorer.1am.xyz/tx/d5fbf036da990bff58f42b96b638bb63fffdedc1b933f249c6e42c2e222f151d?network=preview)) without seeing a single diameter.

How it works:

1. At measuring time, the measuring station publishes a sealed fingerprint of the lot's 32 measurements on Midnight (a salted hash, the *commitment*). Nobody can read the values from it, and from then on they cannot change.
2. When the customer asks, the supplier publishes a zero-knowledge proof of **how many parts sit inside the band**, checked against that fingerprint.
3. The customer sees the count, the verdict under its acceptance number and the transactions. Never the measurements.
4. If one part is disputed, the supplier discloses that single value, proven to belong to the committed lot. The other 31 stay private.

| | |
| --- | --- |
| Live demo | https://lotproof.154-53-53-223.sslip.io (Midnight Preview) |
| Judges' guide | [JUDGES.md](JUDGES.md): three-minute walkthrough, where each claim is enforced, on-chain links |
| Contract on Preview | [`e74b37e7ef6ad0e850bb1b110b9f8bea2f222c2c6700a9bb02fdd3740ae5eb49`](https://explorer.1am.xyz/contract/e74b37e7ef6ad0e850bb1b110b9f8bea2f222c2c6700a9bb02fdd3740ae5eb49?network=preview) (1AM Explorer) |
| Contract on local devnet | deployed and exercised end to end, see [How to verify](#how-to-verify-in-5-minutes) |
| Tests | 19 simulator tests, 10 of them inputs the contract must refuse ([`src/test/lotproof.sim.test.ts`](src/test/lotproof.sim.test.ts)), and 4 end-to-end tests with real proofs ([`src/test/lotproof.test.ts`](src/test/lotproof.test.ts)); simulator tests run in CI on every push |

## What is public and what stays private

| Public on Midnight | Private to the supplier |
| --- | --- |
| Drawing spec: nominal, band, acceptance number | The 32 measurements of each lot |
| The station's commitment to the lot, at measuring time | The salt behind each commitment |
| Count of parts inside the band and the verdict | Which parts are out of band |
| Any part the supplier chooses to disclose | Every part it does not disclose |

## Who uses it and who pays

We showed the demo to a manufacturer in Peru that receives parts from outside suppliers, and asked six questions. It asked to stay anonymous and allowed us to quote it as "a Peruvian manufacturer". Its answers, translated from Spanish:

- **What happens today.** Suppliers send certificates of conformity and dimensional reports as PDF or Excel files, mostly for critical parts. For tight tolerances the buyer reviews the measurements of specific characteristics before accepting a lot.
- **The problem.** Confidentiality: dimensional reports "can reveal details about the precision and consistency of a supplier's manufacturing process", and not every supplier is willing to share complete measurements. And later on, "it can be hard to verify that the documents really belong to the lot that was delivered". The station's commitment answers that second point: the fingerprint is on Midnight before anyone knows the count.
- **Who pays.** The supplier at first, because it is the one that has to show its production meets the agreed spec. A shared cost if the buyer saves inspection and validation time. Per lot, or a monthly subscription for frequent suppliers.
- **What a real trial needs.** Measurements from real production, results that can be verified independently, and integration with the measuring instruments the plant already uses. The quality lead approves it and, depending on scope, operations management.

This is one buyer's view after seeing the demo. It is not a pilot and not a purchase commitment.

Adoption path, in the order the buyer asked for it:

1. **A real lot.** The manufacturer agreed in principle to share one characteristic of a lot it has already inspected, anonymized, once it checks internally what it can release. When it arrives it runs on Preview unchanged and is linked here.
2. **The station.** Today the demo service plays the measuring station. The next piece is an adapter that takes the report the measuring software already exports and commits it at measuring time, so nobody retypes numbers.
3. **Pricing.** Paid by the supplier, per lot or monthly, as the buyer suggested. The customer verifies for free: reading the count and the transactions costs nothing.

What Lotproof does not change: if the instrument measures wrong, the proof is correct about wrong numbers. Trust in the instrument and its calibration stays where it is today.

## Architecture

```
contract/lotproof.compact   Compact contract, 5 circuits
contract/witnesses.ts       private state: admin and station secrets, raw lots
src/                        wallet, providers and network config (Midnight.js 5)
src/test/                   simulator tests and end-to-end tests
server/                     demo service that plays the supplier (one wallet)
web/                        customer and supplier views
compose.yml                 local devnet: node, indexer, proof server
```

### Contract

| Circuit | Who calls it | What reaches the ledger |
| --- | --- | --- |
| `registerStation(station)` | supplier admin | the station's key hash |
| `publishSpec(specId, spec)` | supplier admin | nominal, lower, upper, acceptance number |
| `commitLot(lotId, specId)` | registered station | `persistentHash(values, salt)`, the station key, status `Committed` |
| `proveLot(lotId)` | supplier admin | count inside the band, `Accepted` or `Rejected` |
| `disclosePart(lotId, index)` | supplier admin | one value, proven to be inside the committed lot |

Design choices:

- **Identities come from witness secrets**, hashed with a domain separator (`lotproof:admin:v1`, `lotproof:station:v1`). The contract never relies on `ownPublicKey()`.
- **The commitment is checked inside the proof.** `proveLot` re-hashes the private values and asserts they equal the station's commitment before it counts anything, so numbers changed after measuring cannot be proven (`"Measurements do not match the station commitment"`).
- **Lots have a fixed sample of 32** because Compact vectors have a static length. Counting uses `fold`; picking one disputed part also uses `fold`, since vectors cannot be indexed with a runtime value.
- **Values are micrometres** (`Uint<32>`), so the band check is plain unsigned comparison.

## Midnight integration

| Piece | Version |
| --- | --- |
| Compact toolchain | 0.36.0 (language 0.28) |
| Midnight.js | 5.0.0 |
| Wallet SDK | 2.0.0 (via `@midnight-ntwrk/testkit-js` 5.0.0) |
| Proof server | 9.0.0 |
| Network | Preview (ledger 9), local devnet for tests |

Versions follow the official support matrix for Preview. Wallet and provider wiring follows `midnightntwrk/example-hello-world`.

## Install

Requires Linux or macOS (on Windows, WSL 2), Node 22, Docker and the Compact toolchain.

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update 0.36.0
yarn install --frozen-lockfile
yarn compile
```

## How to verify in 5 minutes

```bash
yarn test:sim        # 19 tests, no network needed
yarn env:up          # local node, indexer and proof server (ports bound to 127.0.0.1)
yarn wait:dust
yarn test:local      # deploys, registers a station, proves a lot, refuses a tampered one
```

`yarn test:local` writes `deployment.local.json` with the contract address and every transaction hash.

To run the demo service and the web views against the local devnet:

```bash
echo "LOTPROOF_STORE_PASSWORD=<a strong password>" > .env.local
set -a; . ./.env.local; set +a
MIDNIGHT_NETWORK=local yarn server     # http://127.0.0.1:8787
```

## Status

Built during Midnight Buildathon Wave 3 (November 2026). Everything in this repository is new in this wave.

- Done: contract, simulator tests, end-to-end tests on a local devnet, demo service, web views, deployment on Preview with a public demo.
- Next: narrated video and deck, a real lot from the manufacturer above, and the station adapter.

The public demo runs `deploy/compose.yml` on a small VM: the proof server and the demo service in Docker with memory and CPU limits, only the service published on 127.0.0.1 behind a TLS reverse proxy. One lot (commit plus proof) takes about 65 s on Preview.

## License

Apache-2.0. Files adapted from `midnightntwrk/example-hello-world` and `midnightntwrk/midnight-examples` keep their Apache-2.0 headers.
