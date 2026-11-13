# Lotproof

[![ci](https://github.com/kasbsquall/lotproof/actions/workflows/ci.yml/badge.svg)](https://github.com/kasbsquall/lotproof/actions/workflows/ci.yml)

**A parts supplier proves a lot is inside the drawing tolerance without handing over its measurements. Months later, the customer can ask a new question about the same lot, and the supplier proves the answer from the measurements sealed on the day they were taken.**

Customers ask suppliers for the raw measurements of every lot before they accept it. Those numbers describe the supplier's process, and suppliers know they end up in the next price negotiation ("[Contract manufacturers] are leery of sharing information that could lead to demands for more price cuts", Matt Littlefield, LNS Research, quoted by SAP). Lotproof gives both sides a third option between "send me everything" and "trust my certificate".

A *lot* is a batch of parts made together. The customer's drawing sets a *tolerance band* (the range every part must fall in) and an *acceptance number* (how many parts may fall outside before the lot is rejected).

**Live on Midnight Preview.** Drawing: a diameter of 12.000 mm ± 0.050, at most 1 part of 32 outside.
- LOT-261113-002: the customer saw **"30 of 32 inside, rejected"** ([3aed6138…3be8a22e](https://explorer.1am.xyz/tx/3aed613850d78d7c7b2ede6bc55e67ff22b09a9ab6a14ef616c9eb883be8a22e?network=preview)) without seeing a single diameter.
- LOT-261113-001 was accepted at 31 of 32. Afterwards the customer asked how many parts fit a tighter band, 12.000 ± 0.020 mm. The supplier proved **"17 of 32"** ([40a0aa77…aec9ac3b](https://explorer.1am.xyz/tx/40a0aa77c9780cf03809a27a013258fd7f44d81af56120d19d9a758baec9ac3b?network=preview)) from the commitment made at measuring time, without measuring again and without revealing a value.

How it works:

1. **The customer sets the rules.** It publishes the drawing spec and approves a measuring station for that spec. The supplier cannot change either.
2. **The station seals the lot.** At measuring time it publishes a hiding *commitment* to the 32 values, bound to that lot and that drawing. Nobody can read the values from it, and from then on they cannot change.
3. **The supplier proves the count.** A zero-knowledge proof of how many parts sit inside the band, checked against the commitment. The customer sees the count and the verdict, never the measurements. Measured lots that were never proven stay visible as a public counter, so the supplier cannot pick which lots to show.
4. **The customer can ask again, later.** It publishes a new band and requests an audit of any committed lot; the supplier answers from the same commitment. Open audits are public too.
5. **One part, if disputed.** The supplier can disclose a single value of a proven lot, proven to belong to the committed lot. The other 31 stay private.

| | |
| --- | --- |
| Live demo | https://lotproof.avanc3.pe (Midnight Preview, no wallet needed) |
| Video | [youtu.be/B-Apg1kcr3k](https://youtu.be/B-Apg1kcr3k): 2:23, narrated walkthrough of the live lots on Preview |
| Deck | [docs/lotproof-deck.pdf](docs/lotproof-deck.pdf): 10 slides, problem, mechanism, what is public, who pays |
| Judges' guide | [JUDGES.md](JUDGES.md): three-minute walkthrough, where each claim is enforced, on-chain links |
| Contract on Preview | [`8ae9c803faa306226eb3203b57f4b48d6f75b797a1aadf02c025b66dfcad9128`](https://explorer.1am.xyz/contract/8ae9c803faa306226eb3203b57f4b48d6f75b797a1aadf02c025b66dfcad9128?network=preview) (1AM Explorer) |
| Tests | 32 simulator tests, 17 of them inputs the contract must refuse ([`src/test/lotproof.sim.test.ts`](src/test/lotproof.sim.test.ts)), run in CI on every push; 5 end-to-end tests with real proofs ([`src/test/lotproof.test.ts`](src/test/lotproof.test.ts)), passed on Midnight Preview on 13 Nov 2026 |

## Why Midnight and not a signed report

A measuring station could sign "30 of 32 inside" and timestamp it. That covers the questions somebody thought of on the day of measuring. It does not cover the ones that come later:

- **A later question, without the data.** When a field failure shows up or the customer tightens a tolerance, it can ask how a lot measured months ago does against a new band. The supplier proves the answer from the sealed values. A signature would need the station to have computed that answer in advance, or the supplier to hand over the raw data.
- **A disputed part, without the rest.** The supplier opens one value and the contract checks that it belongs to the sealed lot. The other values stay private.
- **No quiet selection.** Commitments, proofs and audit requests are counted on a public ledger. If a lot was measured and not proven, or an audit was asked and not answered, both parties can see it.

Midnight keeps the measurements private on the supplier's side and the counters public, in one contract both parties can check.

## What is public and what stays private

| Public on Midnight | Private to the supplier |
| --- | --- |
| Drawing spec: nominal, band, acceptance number | The 32 measurements of each lot |
| The station's commitment to the lot, at measuring time | The randomness behind each commitment |
| Count of parts inside the band and the verdict | Which parts are out of band |
| How many lots were committed and how many were proven | Drawing numbers and lot labels: the ledger only holds keyed hashes of them |
| Audit requests, and the count each answer proves | The values behind every answer |
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
contract/lotproof.compact   Compact contract, 8 circuits
contract/witnesses.ts       private state: admin, customer and station secrets, raw lots
src/                        wallet, providers and network config (Midnight.js 5)
src/test/                   simulator tests and end-to-end tests
server/                     demo service that plays the supplier (one wallet)
web/                        customer and supplier views
compose.yml                 local devnet: node, indexer, proof server
```

### Contract

| Circuit | Who calls it | What reaches the ledger |
| --- | --- | --- |
| constructor `(customerPk)` | supplier, at deployment | the supplier admin key and the customer key |
| `registerStation(station, specId)` | customer | the station's key hash and the one spec it may measure |
| `revokeStation(station)` | customer | removes the station; lots it already committed stay valid |
| `publishSpec(specId, spec)` | customer | nominal, lower, upper, acceptance number |
| `commitLot(lotId)` | approved station | `persistentCommit` of the lot id, the station's spec id and the values, the station key, status `Committed`; `committedLots` + 1 |
| `proveLot(lotId)` | supplier admin | count inside the band, `Accepted` or `Rejected`; `provenLots` + 1 |
| `disclosePart(lotId, index)` | supplier admin | one value of a proven lot, proven to be inside the committed lot, at most once per part |
| `requestAudit(lotId, specId)` | customer | an open audit of a committed lot against another published spec; `requestedAudits` + 1 |
| `answerAudit(lotId, specId)` | supplier admin | the count inside the audit band, proven from the same commitment; `answeredAudits` + 1 |

Design choices:

- **Two parties, two keys.** The customer, not the supplier, approves measuring stations and sets the band and the acceptance number. The supplier proves and discloses. One contract per supplier-customer relationship.
- **Identities come from witness secrets**, hashed with a domain separator (`lotproof:admin:v1`, `lotproof:customer:v1`, `lotproof:station:v1`). The contract never relies on `ownPublicKey()`.
- **The commitment is checked inside the proof.** `proveLot` recomputes the commitment from the private values and asserts it equals the station's before it counts anything, so numbers changed after measuring cannot be proven (`"Measurements do not match the station commitment"`).
- **A commitment opens for one lot only.** It is a `persistentCommit` over a domain tag, the lot id, the spec id and the values, so one lot's measurements cannot be reused to prove another lot or another drawing.
- **The station cannot choose the band.** The customer approves each station for one spec, and `commitLot` takes the spec from that approval.
- **Unproven lots and unanswered audits are visible.** `committedLots - provenLots` and `requestedAudits - answeredAudits` are public, so the supplier cannot quietly pick which lots or questions to answer.
- **Ids carry no labels.** The demo derives lot and drawing ids with a keyed hash (SHA-256 over a key the two parties share off-chain), so production dates and drawing numbers never reach the public ledger.
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
yarn test:sim        # 32 tests, no network needed
yarn env:up          # local node, indexer and proof server (ports bound to 127.0.0.1)
yarn wait:dust
yarn test:local      # deploys, approves a station, proves and rejects lots, refuses a tampered one, answers an audit
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

- Done: contract with customer audits, simulator tests, end-to-end tests on a local devnet and on Preview, demo service, web views, public demo on Preview, deck, narrated video.
- Next: a real lot from the manufacturer above, and the station adapter.

The public demo at lotproof.avanc3.pe runs `deploy/compose.yml` on a small VM: the proof server and the demo service in Docker with memory and CPU limits, only the service published on 127.0.0.1 behind a TLS reverse proxy. One lot (commit plus proof) takes about 70 to 80 s on Preview.

## License

Apache-2.0. Files adapted from `midnightntwrk/example-hello-world` and `midnightntwrk/midnight-examples` keep their Apache-2.0 headers.
