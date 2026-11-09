// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import path from 'node:path';

export {
  Contract,
  ledger,
  pureCircuits,
  LotStatus,
  type Spec,
  type Lot,
  type Witnesses,
  type Ledger,
  type ImpureCircuits,
  type PureCircuits,
} from './managed/lotproof/contract/index.js';
import { Contract } from './managed/lotproof/contract/index.js';
import { witnesses } from './witnesses.js';

export * from './witnesses.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkConfigPath = path.resolve(currentDir, 'managed', 'lotproof');

export const CompiledLotproofContract = CompiledContract.make('LotproofContract', Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
