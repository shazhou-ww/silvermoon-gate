export type GateJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly GateJsonValue[]
  | { readonly [key: string]: GateJsonValue };

export type GateRequestStatus =
  "pending" | "approved" | "rejected" | "withdrawn";

export type GateRequestAction = "approve" | "reject" | "withdraw";

export interface CreateGateRequest {
  readonly idempotencyKey: string;
  readonly payload: GateJsonValue;
  readonly payloadSchemaVersion: number;
  readonly requesterIdentityId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly threadId?: string;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON numbers must be finite.");
    }

    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    assertWellFormedString(value);
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = Array.from({ length: value.length }, (_, index) =>
      canonicalizeJson(value[index]),
    );
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects.");
    }

    const record = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    const stringKeys = keys.filter(
      (key): key is string => typeof key === "string",
    );
    if (stringKeys.length !== keys.length) {
      throw new TypeError("JSON objects must have string keys.");
    }

    const entries = stringKeys.sort().map((key) => {
      assertWellFormedString(key);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("JSON objects must contain enumerable data.");
      }
      return `${JSON.stringify(key)}:${canonicalizeJson(descriptor.value)}`;
    });

    return `{${entries.join(",")}}`;
  }

  throw new TypeError("Value is not representable as JSON.");
}

export async function calculatePayloadDigest(
  schemaVersion: number,
  payload: GateJsonValue,
): Promise<string> {
  assertPositiveInteger(schemaVersion, "Payload schema version");

  return sha256(canonicalizeJson({ payload, schemaVersion }));
}

export async function calculateRequestFingerprint(
  request: CreateGateRequest,
): Promise<string> {
  assertNonEmptyString(request.idempotencyKey, "Idempotency key");
  assertNonEmptyString(request.requesterIdentityId, "Requester identity ID");
  assertNonEmptyString(request.templateId, "Template ID");
  assertPositiveInteger(request.payloadSchemaVersion, "Payload schema version");
  assertPositiveInteger(request.templateVersion, "Template version");
  if (request.threadId !== undefined) {
    assertNonEmptyString(request.threadId, "Thread ID");
  }

  return sha256(canonicalizeJson(request));
}

export function transitionRequestStatus(
  status: GateRequestStatus,
  action: GateRequestAction,
): GateRequestStatus {
  if (status !== "pending") {
    throw new Error(`Cannot ${action} a ${status} request.`);
  }

  switch (action) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "withdraw":
      return "withdrawn";
  }
}

async function sha256(canonicalJson: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `sha256:${hex}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new TypeError(`${label} must not be empty.`);
  }
}

function assertWellFormedString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) {
        throw new TypeError("JSON strings must contain valid Unicode.");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JSON strings must contain valid Unicode.");
    }
  }
}
