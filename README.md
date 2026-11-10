# Lotproof

**A parts supplier proves a lot is inside the drawing tolerance without handing over its measurements.**

Customers ask suppliers for the raw measurements of every lot before they accept it. Those numbers describe the supplier's process, and suppliers know they end up in the next price negotiation ("CMs are leery of sharing information that could lead to demands for more price cuts", Matt Littlefield, LNS Research, quoted by SAP). Lotproof gives both sides a third option between "send me everything" and "trust my certificate":

1. The measuring station (a registered CMM) publishes the salted hash of the lot's 32 measurements on Midnight **at measuring time**. From then on the values cannot change.
2. When the customer asks, the supplier publishes a zero-knowledge proof of **how many parts sit inside the band**, checked against that hash.
3. The customer sees the count, the verdict under its own acceptance number and the transactions. Never the numbers.
4. If one part is disputed, the supplier discloses that single value, proven to belong to the committed lot. The other 31 stay private.

| | |
| --- | --- |
| Live demo | https://lotproof.154-53-53-223.sslip.io (Midnight Preview) |
| Video | pending |
| Contract on Preview | [`e74b37e7ef6ad0e850bb1b110b9f8bea2f222c2c6700a9bb02fdd3740ae5eb49`](https://explorer.1am.xyz/contract/e74b37e7ef6ad0e850bb1b110b9f8bea2f222c2c6700a9bb02fdd3740ae5eb49?network=preview) (1AM Explorer) |
| Contract on local devnet | deployed and exercised end to end, see [How to verify](#how-to-verify-in-5-minutes) |
| Tests | 19 simulator tests (10 of them inputs the contract must refuse) and 4 end-to-end tests with real proofs |

## What is public and what stays private

| Public on Midnight | Private to the supplier |
| --- | --- |
| Drawing spec: nominal, band, acceptance number | The 32 measurements of each lot |
| The station's commitment to the lot, at measuring time | The salt behind each commitment |
| Count of parts inside the band and the verdict | Which parts are out of band |
| Any part the supplier chooses to disclose | Every part it does not disclose |

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
- Pending: video and deck.

The public demo runs `deploy/compose.yml` on a small VM: the proof server and the demo service in Docker with memory and CPU limits, only the service published on 127.0.0.1 behind a TLS reverse proxy. One lot (commit plus proof) takes about 65 s on Preview.

## License

Apache-2.0. Files adapted from `midnightntwrk/example-hello-world` and `midnightntwrk/midnight-examples` keep their Apache-2.0 headers.
