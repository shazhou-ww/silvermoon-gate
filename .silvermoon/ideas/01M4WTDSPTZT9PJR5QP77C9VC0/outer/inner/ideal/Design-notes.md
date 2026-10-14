# Gate Service design boundaries

These are the current direction established during idea shaping, not a final
protocol or implementation specification.

## Identity and delegated authority

- Identity represents an authenticated human or Agent/workload. Gate manages
  authentication; human MFA is selected per template, while Agents use
  short-lived access tokens tied to their own Identity.
- Creation lineage records responsibility, not permission. Creating an Agent or
  another Identity never implicitly inherits authority.
- Delegate is a separate, non-login permission-scope entity. Its scope is
  immutable; changing scope means creating a new Delegate. Its owner may define
  only a subset of authority they already hold and are allowed to delegate.
- Grant assigns a Delegate to a specific Identity for a validity period. The
  owner issues or revokes Grants; delegation onward is disabled unless
  explicitly permitted, and any downstream scope and validity must fit within
  the upstream Grant.
- Approval evidence distinguishes the Identity whose authority is evaluated from
  the actual authenticated actor. A delegated action binds both identities and
  the applicable Delegate and Grant. Disabling a Delegate prevents future use
  but does not rewrite past credentials.

## Requests and approval behavior

- GateTemplate is versioned, and a request pins its template version. Eligible
  approvers are dynamically resolved when a decision is submitted.
- The first eligible approver to atomically submit either an approval or
  rejection determines the terminal result. Concurrent later decisions cannot
  overwrite it.
- Gate has no approval timeout. The requester may withdraw only a pending
  request; rejection or withdrawal followed by a retry creates a new request.
- Creation is idempotent per requester and key; reuse with different request
  content is a conflict. Payload is an immutable JSON snapshot after creation.
- GateURI is only a locator, never an access capability. A caller-defined Thread
  can group request history, but Thread ownership/ACL does not replace
  per-request authorization.

## Payload, credentials, and trust

- Gate stores the complete payload for long-term audit. Payload is canonicalized
  using RFC 8785 JCS and hashed with SHA-256, with its schema version bound into
  the digest claim.
- A standard signed credential binds the request, pinned template, decision,
  payload digest, approval authority, actual actor, and Gate's assertion that
  identity and authorization checks passed at decision time.
- Offline release requires both valid signature verification and a match against
  the caller's expected payload digest. Offline verification trusts Gate's
  authorization assertion; it does not independently replay the identity graph.
- Credentials remain immutable historical records. If a signing key is confirmed
  compromised, every credential for that `keyId` is treated as untrusted. An
  offline verifier only knows the key-status snapshot it possesses; its result
  must identify that snapshot.

## Audit and operational boundaries

- Current relationship state and its append-only audit event are committed
  atomically in the same database. Database immutability controls, access
  separation, backup, and audit reduce tampering risk; no external cryptographic
  log anchor is assumed.
- Identity retirement means disable and seal, retaining non-reusable identifiers
  and history rather than deleting historical evidence.
- The service repository is `shazhou-ww/silvermoon-gate`, derived from
  `shazhou-ww/preset-cloudflare-fullstack`; the intended hosting platform is
  Cloudflare Workers and the configured hostname is `gate.silvermoon.work`.
  Cloudflare account ownership, zone eligibility, deployment access, and
  operational key custody remain to be verified. No DNS changes or deployment
  have been performed.
