/**
 * The canonical univocity instance identifier (devdocs ADR-0059 decision 7,
 * plan-2607-43 D1/D6).
 *
 * One identifier, one name: a univocity instance — a deployed contract,
 * identified by its chain binding — IS the fee account, so a single value
 * serves both the delegation-coordinator grouping role and the receivables
 * account role. The canonical rendering is CAIP-10, lowercased:
 *
 *     eip155:{decimal chainId}:0x{40 lowercase hex}
 *
 * Parsing is reject-never-repair: anything that is not the exact canonical
 * form is an error, including the retired bespoke `{chainId}:{addr40}` form
 * and checksum-cased addresses. Construction helpers normalise trusted
 * internal inputs (stored chain bindings, genesis wire bytes) into the
 * canonical form; parsing external input never does.
 *
 * `chainBinding { chainId, univocityAddr }` remains the structured form on
 * stored records; this module is the only place conversion happens.
 */

/** Canonical form: CAIP-10, eip155 namespace, lowercased. */
const UNIVOCITY_INSTANCE_ID_PATTERN =
  /^eip155:[1-9][0-9]{0,31}:0x[0-9a-f]{40}$/;

/** Decimal chain id, no leading zeros (CAIP-2 eip155 reference). */
const CHAIN_ID_PATTERN = /^[1-9][0-9]{0,31}$/;

/** 40 hex chars, optional 0x prefix, any case (construction input only). */
const ADDR_INPUT_PATTERN = /^(0x)?[0-9a-fA-F]{40}$/;

/** Validation failure (callers map to 4xx or treat as absent per context). */
export class UnivocityInstanceIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnivocityInstanceIdError";
  }
}

/**
 * A validated canonical univocity instance id. Produced only by this module;
 * treat as opaque elsewhere.
 */
export type UnivocityInstanceId = string;

/**
 * Parse an externally supplied value. Exact canonical form only — no case
 * folding, no prefix repair, no legacy acceptance.
 *
 * @param value - Candidate string.
 * @returns The value, validated.
 * @throws UnivocityInstanceIdError when not canonical.
 */
export function parseUnivocityInstanceId(value: string): UnivocityInstanceId {
  if (!UNIVOCITY_INSTANCE_ID_PATTERN.test(value)) {
    throw new UnivocityInstanceIdError(
      "not a canonical univocity instance id (expected eip155:{chainId}:0x{40 lowercase hex})",
    );
  }
  return value;
}

/**
 * Non-throwing form check for guards and request validation.
 *
 * @param value - Candidate string.
 */
export function isUnivocityInstanceId(
  value: string,
): value is UnivocityInstanceId {
  return UNIVOCITY_INSTANCE_ID_PATTERN.test(value);
}

/**
 * Construct from a stored chain binding (registration record shape). Trusted
 * internal input: tolerates an optional 0x prefix and any hex case, renders
 * canonical.
 *
 * @param binding - `{ chainId, univocityAddr }`.
 * @throws UnivocityInstanceIdError when the binding cannot render canonically.
 */
export function univocityInstanceIdFromChainBinding(binding: {
  chainId: string;
  univocityAddr: string;
}): UnivocityInstanceId {
  const chainId = binding.chainId?.trim() ?? "";
  if (!CHAIN_ID_PATTERN.test(chainId)) {
    throw new UnivocityInstanceIdError(
      "chain binding chainId is not a bare decimal chain id",
    );
  }
  const addrRaw = binding.univocityAddr?.trim() ?? "";
  if (!ADDR_INPUT_PATTERN.test(addrRaw)) {
    throw new UnivocityInstanceIdError(
      "chain binding univocityAddr is not a 40-hex address",
    );
  }
  const addr = addrRaw.toLowerCase().replace(/^0x/, "");
  return `eip155:${chainId}:0x${addr}`;
}

/**
 * As {@link univocityInstanceIdFromChainBinding} but returns undefined
 * instead of throwing. For paths where a missing or malformed binding means
 * "no instance binding" (a supported configuration), not an error.
 *
 * @param binding - `{ chainId, univocityAddr }`.
 */
export function tryUnivocityInstanceIdFromChainBinding(binding: {
  chainId: string;
  univocityAddr: string;
}): UnivocityInstanceId | undefined {
  try {
    return univocityInstanceIdFromChainBinding(binding);
  } catch {
    return undefined;
  }
}

/**
 * Construct from genesis wire material (address as raw bytes).
 *
 * @param chainId - Bare decimal chain id string.
 * @param address - 20-byte contract address.
 * @throws UnivocityInstanceIdError when inputs cannot render canonically.
 */
export function univocityInstanceIdFromAddressBytes(
  chainId: string,
  address: Uint8Array,
): UnivocityInstanceId {
  if (address.length !== 20) {
    throw new UnivocityInstanceIdError(
      "genesis chain binding address is not 20 bytes",
    );
  }
  const addrHex = Array.from(address)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return univocityInstanceIdFromChainBinding({
    chainId,
    univocityAddr: addrHex,
  });
}

/**
 * Recover the structured chain binding from a canonical id. The address is
 * returned unprefixed lowercase 40-hex, matching the stored
 * `RegistrationRecord.chainBinding` form.
 *
 * @param id - A canonical univocity instance id.
 * @throws UnivocityInstanceIdError when the input is not canonical.
 */
export function chainBindingFromUnivocityInstanceId(id: string): {
  chainId: string;
  univocityAddr: string;
} {
  parseUnivocityInstanceId(id);
  const [, chainId, prefixedAddr] = id.split(":");
  return { chainId, univocityAddr: prefixedAddr.slice(2) };
}
