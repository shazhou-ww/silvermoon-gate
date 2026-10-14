# Gate Service: a reusable approval gateway

## Problem

PGH regression tasks, AI agents, and human workflows need approval, but
embedding approval rules and identity resolution in each caller creates
duplicated policy and inconsistent audit trails. Callers also need a dependable
way to verify past decisions without making every check depend on the live Gate
service.

## Outcome

A reusable service accepts approval requests, applies a consistent identity- and
template-based policy, and produces a signed decision credential that callers
can verify against the exact business payload. Approval history remains
attributable and auditable across service outages and future reviews.

## Boundaries

- Keep approval policy and identity authorization inside Gate; callers integrate
  request creation, blocking, and resumption without reimplementing those rules.
- Distinguish authenticated actors from delegated permission scopes: an Identity
  operates under an explicitly granted, bounded Delegate; creation lineage alone
  grants no permission.
- The implementation repository is `shazhou-ww/silvermoon-gate`, derived from
  the Cloudflare full-stack preset; the intended Worker hostname is
  `gate.silvermoon.work`. Account ownership and production deployment remain
  subject to setup and verification.

## Acceptance criteria

- A caller can create and track an approval request under a reusable, versioned
  template, and one eligible approver's first decision becomes the immutable
  outcome.
- A signed credential binds the decision to the request, the exact payload
  digest, the approval authority, and the actual actor, and an independent
  verifier can validate it offline against a stated trust-bundle snapshot.
- The identity, delegation, request, and decision history supports audit of who
  acted, under what authority, and what Gate asserted at the time.
