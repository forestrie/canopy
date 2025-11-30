# @canopy/merklelog

TypeScript implementation of the MMR (Merkle Mountain Range) merklelog format.

This package provides TypeScript implementations of the algorithms and data structures defined by the [go-merklelog](https://github.com/forestrie/go-merklelog) project.

## Overview

The package is organized into three main modules:

- **uint64**: BigInt-based wrapper for 64-bit unsigned integer operations
- **mmr**: Core MMR algorithms including inclusion proofs, consistency proofs, and mathematical operations
- **massifs**: Efficient buffer-based access to massif blob data

## Installation

```bash
pnpm add @canopy/merklelog
```

## Usage

### Uint64

```typescript
import { Uint64 } from "@canopy/merklelog";

const a = new Uint64(42);
const b = new Uint64(10);
const sum = a.add(b);
console.log(sum.toBigInt()); // 52n
```

### Massif

```typescript
import { Massif } from "@canopy/merklelog";

const buffer = new Uint8Array(/* massif blob data */);
const massif = new Massif(buffer);

// Read fields dynamically
const lastID = massif.lastID;
const massifIndex = massif.massifIndex;

// Get complete start information
const start = massif.getStart();

// Access field by index
const field = massif.fieldref(0); // Returns 32-byte field at index 0
```

### MMR Algorithms

```typescript
import { bagPeaks, verifyInclusion, Hasher } from "@canopy/merklelog";

// Bag peaks to compute root
const root = bagPeaks(hasher, peakHashes);

// Verify inclusion proof
const isValid = verifyInclusion(hasher, leafHash, proof, root);
```

## Terminology

This package follows the terminology defined in the [term cheatsheet](https://raw.githubusercontent.com/forestrie/go-merklelog/refs/heads/main/term-cheatsheet.md):

- **mmrIndex**: Zero-based index of a node in the MMR
- **mmrPosition**: One-based position of a node (mmrIndex + 1)
- **leafIndex**: Zero-based index of a leaf node
- **heightIndex (g)**: Zero-based height index
- **height (h)**: One-based height (g + 1)

## References

- [go-merklelog](https://github.com/forestrie/go-merklelog) - Original Go implementation
- [Term Cheatsheet](https://raw.githubusercontent.com/forestrie/go-merklelog/refs/heads/main/term-cheatsheet.md)
- [MMR Math Cheatsheet](https://raw.githubusercontent.com/forestrie/go-merklelog/refs/heads/main/mmr-math-cheatsheet.md)

## License

See LICENSE file in the repository.
