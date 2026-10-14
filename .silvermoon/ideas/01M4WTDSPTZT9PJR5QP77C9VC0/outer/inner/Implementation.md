# Implementation

## Steps

### I-S01: Implement versioned request and template behavior

Implement versioned templates and requests in Cloudflare D1. Requests pin
template and payload-schema versions while resolving the eligible approver
roster dynamically at decision time. Persist canonical immutable payload
snapshots, idempotency fingerprints, requester-defined thread IDs, and
append-only request and approver-roster audit events. Make withdrawal and the
first eligible approve/reject decision conditional and atomic with their audit
event.

### I-S02: Define identity and delegated authority

Specify Identity, immutable Delegate scope, time-bounded Grant, delegation
limits, actor attribution, authentication, and the authorization checks
performed at decision time.

### I-S03: Define credentials and audit boundaries

Specify payload canonicalization, signed credential claims, offline verification
and key-status semantics, plus atomic state/audit persistence and protected
payload handling.

## Acceptance criteria

### I-AC01: Requests have deterministic outcomes

Requests persist in D1 with pinned template/schema versions, dynamic
decision-time approvers, canonical payload snapshots, and requester-scoped
idempotency; only a pending request can be withdrawn by its requester or decided
once by an eligible approver, with matching append-only audit events. Prove it
by applying the production migration to SQLite and running store/API tests for
normal creation, replay/conflict, access control, withdrawal, approver
replacement, and competing decisions.

### I-AC02: Delegated actions are attributable and bounded

A reviewed authorization model distinguishes actor, Delegate, and Grant and
rejects expired, revoked, out-of-scope, or disallowed transitive use; prove it
with authorization tests and audit examples.

### I-AC03: Credentials verify the intended decision

An independent verifier validates the standard signed credential and requires an
exact expected payload-digest match while reporting its trust-bundle version;
prove it with cross-implementation test vectors, key-status cases, and database
consistency tests.
