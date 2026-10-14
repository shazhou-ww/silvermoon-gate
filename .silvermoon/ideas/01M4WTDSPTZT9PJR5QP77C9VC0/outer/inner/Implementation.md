# Implementation

## Steps

### I-S01: Implement versioned request and template behavior

Define and implement version-pinned template and request contracts, request
lifecycle, idempotent creation, withdrawal, threading, and atomic first-decision
behavior.

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

A reviewed contract defines template version pinning, dynamic approver
resolution, idempotency conflicts, withdrawal, and single-winner concurrent
decisions; prove it with contract tests covering normal and competing
submissions.

### I-AC02: Delegated actions are attributable and bounded

A reviewed authorization model distinguishes actor, Delegate, and Grant and
rejects expired, revoked, out-of-scope, or disallowed transitive use; prove it
with authorization tests and audit examples.

### I-AC03: Credentials verify the intended decision

An independent verifier validates the standard signed credential and requires an
exact expected payload-digest match while reporting its trust-bundle version;
prove it with cross-implementation test vectors, key-status cases, and database
consistency tests.
