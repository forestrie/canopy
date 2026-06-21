import { logIdToStorageSegment } from "../grant/log-id-wire.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import type { ForestGenesisChainBinding } from "../forest/genesis-wire.js";
import type { RegistrationRecord } from "./registration-record.js";

export interface RegistrationStoreEnv {
  R2_GRANTS: R2Bucket;
}

function registrationR2Key(storageSeg: string): string {
  return `forests/forest/${storageSeg}/registration.json`;
}

function chainBindingToStored(
  binding: ForestGenesisChainBinding,
): RegistrationRecord["chainBinding"] {
  return {
    chainId: binding.chainId,
    univocityAddr: Array.from(binding.address)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  };
}

export async function writeRegistration(
  env: RegistrationStoreEnv,
  logIdWire: Uint8Array,
  record: Omit<RegistrationRecord, "createdAt"> & { createdAt?: number },
): Promise<void> {
  const storageSeg = logIdToStorageSegment(logIdWire);
  const key = registrationR2Key(storageSeg);
  const head = await env.R2_GRANTS.head(key);
  if (head) return;
  const body: RegistrationRecord = {
    ...record,
    createdAt: record.createdAt ?? Math.floor(Date.now() / 1000),
  };
  await env.R2_GRANTS.put(key, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function readRegistration(
  env: RegistrationStoreEnv,
  logIdWire: Uint8Array,
): Promise<RegistrationRecord | null> {
  const storageSeg = logIdToStorageSegment(logIdWire);
  const got = await env.R2_GRANTS.get(registrationR2Key(storageSeg));
  if (!got) return null;
  try {
    return JSON.parse(
      new TextDecoder().decode(new Uint8Array(await got.arrayBuffer())),
    ) as RegistrationRecord;
  } catch {
    return null;
  }
}

export function registrationRecordFromChainBinding(
  opts:
    | {
        class: "payment-authoritative";
        onboardTokenRef: string;
        chainBinding: ForestGenesisChainBinding;
      }
    | {
        class: "regular";
        endorsedBy: string;
        chainBinding: ForestGenesisChainBinding;
      },
): Omit<RegistrationRecord, "createdAt"> {
  const chainBinding = chainBindingToStored(opts.chainBinding);
  if (opts.class === "payment-authoritative") {
    return {
      class: opts.class,
      onboardTokenRef: opts.onboardTokenRef,
      chainBinding,
    };
  }
  return {
    class: opts.class,
    endorsedBy: opts.endorsedBy,
    chainBinding,
  };
}

export function logIdWireToUuid(logIdWire: Uint8Array): string {
  return bytesToUuid(logIdWire);
}
