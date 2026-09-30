# Immutable V1 regression reference

`runtime/wallet.mjs` and `artifacts/TransAtlasEscrow.abi.json` are unchanged copies
from TA commit `bad53cc9c2248950339738af9c8af6fb5a8e3c3d`. They are test-only
historical inputs, never mounted or imported by the current runtime.

The R21-04 regression executes the real old reconciler against local chain
receipts to generate populated V1 history before exercising current V2 migration.
