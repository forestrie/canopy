import { ClientErrors } from "./problem-details";

export function validateUUID(id: string | undefined): Response | null {
  if (!id) return ClientErrors.badRequest("Missing id");
  const ok =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    );
  return ok ? null : ClientErrors.badRequest("id must be a UUID");
}

export function validateLogId(id: string | undefined): Response | null {
  if (!id) return ClientErrors.badRequest("Missing logId");
  const ok =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    );
  return ok ? null : ClientErrors.badRequest("logId must be a UUID");
}

export function validateOperationId(id: string | undefined): Response | null {
  if (!id) return ClientErrors.badRequest("Missing operationId");
  // Operation IDs are typically in format: "00000000-etag" or just a UUID
  // Allow either format
  const isOperationFormat = /^[0-9]{8}-[0-9a-zA-Z_-]+$/i.test(id);
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    );
  return isOperationFormat || isUuid
    ? null
    : ClientErrors.badRequest("Invalid operationId format");
}

export function validateEntryId(id: string | undefined): Response | null {
  // Entry IDs can be UUIDs or content hashes (hex strings)
  if (!id) return ClientErrors.badRequest("Missing entryId");

  // Check if it's a UUID
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    );
  if (isUuid) return null;

  // Check if it's a hex hash (32 or 64 characters for MD5/SHA256)
  const isHash = /^[0-9a-f]{32,64}$/i.test(id);
  if (isHash) return null;

  return ClientErrors.badRequest("entryId must be a UUID or hex hash");
}

export function validateScrapiRequest(
  request: Request,
  options: {
    methods?: string[];
    contentTypes?: string[];
    maxBodySize?: number;
    requireAuth?: boolean;
  },
): Response | null {
  // Method validation
  if (options.methods && !options.methods.includes(request.method)) {
    return ClientErrors.badRequest(`Method ${request.method} not allowed`);
  }

  // Content-Type validation for requests with bodies
  if (request.method === "POST" || request.method === "PUT") {
    const contentType = request.headers.get("content-type");
    if (!contentType) {
      return ClientErrors.badRequest("Content-Type header required");
    }

    if (options.contentTypes) {
      const matches = options.contentTypes.some((ct) =>
        contentType.toLowerCase().includes(ct.toLowerCase()),
      );
      if (!matches) {
        return ClientErrors.unsupportedMediaType(
          `Expected one of: ${options.contentTypes.join(", ")}`,
        );
      }
    }
  }

  return null;
}
