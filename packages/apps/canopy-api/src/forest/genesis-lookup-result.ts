import type { ParsedForestGenesis } from "./parsed-forest-genesis.js";

export type GenesisLookupResult =
  | ParsedForestGenesis
  | { kind: "bad_segment" }
  | { kind: "not_found" }
  | { kind: "corrupt" };
