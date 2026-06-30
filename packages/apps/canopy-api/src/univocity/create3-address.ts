import {
  encodePacked,
  getContractAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export const CREATE3_PROXY_BYTECODE =
  "0x67363d3d37363d34f03d5260086018f3" as const;

export const CREATE3_PROXY_BYTECODE_HASH = keccak256(CREATE3_PROXY_BYTECODE);

export function predictCreate3Address(
  deployer: Address,
  saltString: string,
  factory: Address,
): Address {
  const salt = keccak256(toBytes(saltString));
  const hashedSalt = keccak256(
    encodePacked(["address", "bytes32"], [deployer, salt]),
  );
  return predictCreate3AddressWithHashedSalt(hashedSalt, factory);
}

export function predictCreate3AddressWithHashedSalt(
  hashedSalt: Hex,
  factory: Address,
): Address {
  const proxy = getContractAddress({
    bytecodeHash: CREATE3_PROXY_BYTECODE_HASH,
    from: factory,
    opcode: "CREATE2",
    salt: hashedSalt,
  });
  return getContractAddress({
    from: proxy,
    nonce: 1n,
  });
}
