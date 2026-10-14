import { describe, expect, it } from "vitest";

import {
  authProviderIds,
  calculatePayloadDigest,
  calculateRequestFingerprint,
  canonicalizeJson,
  getAuthProviderLabel,
  transitionRequestStatus,
} from "../src/index.js";

describe("getAuthProviderLabel", () => {
  it("labels every supported provider", () => {
    expect(authProviderIds.map(getAuthProviderLabel)).toEqual([
      "GitHub",
      "Google",
      "Microsoft",
    ]);
  });
});

describe("canonicalizeJson", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(
      canonicalizeJson({
        z: [{ y: 2, x: 1 }],
        a: "value",
      }),
    ).toBe('{"a":"value","z":[{"x":1,"y":2}]}');
  });

  it("uses JSON number and string serialization", () => {
    expect(canonicalizeJson([-0, 1e-7, 'quote"', "line\nbreak", "🙂"])).toBe(
      '[0,1e-7,"quote\\"","line\\nbreak","🙂"]',
    );
  });

  it("accepts null-prototype JSON records", () => {
    const record: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    Object.assign(record, { value: true });
    expect(canonicalizeJson(record)).toBe('{"value":true}');
  });

  it("rejects sparse arrays and objects with symbol keys", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalizeJson(sparse)).toThrow(
      "Value is not representable as JSON.",
    );

    expect(() => canonicalizeJson({ [Symbol("hidden")]: true })).toThrow(
      "JSON objects must have string keys.",
    );
  });

  it("rejects accessors and non-enumerable object fields", () => {
    expect(() =>
      canonicalizeJson(
        Object.defineProperty({}, "value", {
          enumerable: true,
          get: () => true,
        }),
      ),
    ).toThrow("JSON objects must contain enumerable data.");

    expect(() =>
      canonicalizeJson(
        Object.defineProperty({}, "value", {
          enumerable: false,
          value: true,
        }),
      ),
    ).toThrow("JSON objects must contain enumerable data.");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => canonicalizeJson(value)).toThrow(
        "JSON numbers must be finite.",
      );
    },
  );

  it("rejects non-plain objects", () => {
    expect(() => canonicalizeJson(new Date())).toThrow(
      "JSON objects must be plain objects.",
    );
  });

  it.each(["\ud800", "\udc00"])("rejects unpaired surrogate %s", (value) => {
    expect(() => canonicalizeJson(value)).toThrow(
      "JSON strings must contain valid Unicode.",
    );
  });

  it("rejects malformed Unicode in object keys", () => {
    expect(() => canonicalizeJson({ ["\ud800"]: true })).toThrow(
      "JSON strings must contain valid Unicode.",
    );
  });

  it("rejects values that JSON cannot represent", () => {
    expect(() => canonicalizeJson(undefined)).toThrow(
      "Value is not representable as JSON.",
    );
  });
});

describe("Gate request contracts", () => {
  const request = {
    idempotencyKey: "submit-001",
    payload: { amount: 42, currency: "USD" },
    payloadSchemaVersion: 1,
    requesterIdentityId: "identity-requester",
    templateId: "purchase",
    templateVersion: 3,
  } as const;

  it("binds payload digests to the schema version", async () => {
    const digestV1 = await calculatePayloadDigest(1, request.payload);
    const digestV2 = await calculatePayloadDigest(2, request.payload);

    expect(digestV1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestV2).not.toBe(digestV1);
    await expect(calculatePayloadDigest(0, request.payload)).rejects.toThrow(
      "Payload schema version must be a positive safe integer.",
    );
  });

  it("fingerprints an idempotent request independent of object key order", async () => {
    const fingerprint = await calculateRequestFingerprint(request);
    const reordered = await calculateRequestFingerprint({
      ...request,
      payload: { currency: "USD", amount: 42 },
    });
    const changed = await calculateRequestFingerprint({
      ...request,
      payload: { currency: "USD", amount: 43 },
    });

    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reordered).toBe(fingerprint);
    expect(changed).not.toBe(fingerprint);
  });

  it("validates request identifiers and pinned versions", async () => {
    await expect(
      calculateRequestFingerprint({ ...request, idempotencyKey: " " }),
    ).rejects.toThrow("Idempotency key must not be empty.");
    await expect(
      calculateRequestFingerprint({ ...request, requesterIdentityId: " " }),
    ).rejects.toThrow("Requester identity ID must not be empty.");
    await expect(
      calculateRequestFingerprint({ ...request, templateId: " " }),
    ).rejects.toThrow("Template ID must not be empty.");
    await expect(
      calculateRequestFingerprint({ ...request, templateVersion: 0 }),
    ).rejects.toThrow("Template version must be a positive safe integer.");
    await expect(
      calculateRequestFingerprint({ ...request, payloadSchemaVersion: 0 }),
    ).rejects.toThrow(
      "Payload schema version must be a positive safe integer.",
    );
    await expect(
      calculateRequestFingerprint({ ...request, threadId: " " }),
    ).rejects.toThrow("Thread ID must not be empty.");
  });
});

describe("transitionRequestStatus", () => {
  it.each([
    ["approve", "approved"],
    ["reject", "rejected"],
    ["withdraw", "withdrawn"],
  ] as const)("transitions pending requests through %s", (action, status) => {
    expect(transitionRequestStatus("pending", action)).toBe(status);
  });

  it.each(["approved", "rejected", "withdrawn"] as const)(
    "does not allow a second action after %s",
    (status) => {
      expect(() => transitionRequestStatus(status, "approve")).toThrow(
        `Cannot approve a ${status} request.`,
      );
    },
  );
});
