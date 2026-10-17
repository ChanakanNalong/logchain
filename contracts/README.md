# contracts/

Source of the on-chain anchor used by the backend (`src/blockchain`).

## LogIntegrity.sol

Stores one Merkle root per batch on Polygon Amoy, write-once (`storeRoot`
reverts `Root already exists` on a second write for the same batchId) and
owner-only (`onlyOwner` → `Not authorized`). `getRoot` / `verifyRoot` are views.

This file is byte-for-byte the verified source on PolygonScan. The full Hardhat
project (config, tests, Ignition deploy) lives separately at
`~/Documents/logchain-contracts`.

### Deployed instances (Polygon Amoy, chainId 80002)

| Address | Owner / creator | Used by |
|---|---|---|
| `0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5` | `0x8cBCfC045Aa4058816D24Af7C0BEf88515B34C55` | local / thesis stack (`CONTRACT_ADDRESS` in `.env`) |
| `0xF05D8e0c743180483AbBADcBA79A3DA2AAdd8F0B` | `0xA03e739e622Cd8D6D65b9b36ea226b17EE661C59` | cloud stack (CT141) |

### Build / verification

- solc `0.8.28+commit.7893614a`, optimizer **enabled, runs 200**, EVM **cancun**
- Both addresses: **Source Code Verified — Exact Match** on amoy.polygonscan.com
- Runtime bytecode compiled from this source (production profile) matches
  `eth_getCode` of both addresses exactly, including the trailing metadata hash.
