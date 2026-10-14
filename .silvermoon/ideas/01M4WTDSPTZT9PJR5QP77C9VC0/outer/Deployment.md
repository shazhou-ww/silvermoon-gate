# Deployment

## Steps

### D-S01: Select the service home and operating owner

Use `shazhou-ww/silvermoon-gate` as the service repository and Cloudflare
Workers as the intended host. Confirm the operating owner, Cloudflare account
access. Before deployment, verify that `gate.silvermoon.work` belongs to an
active zone and has no conflicting DNS record that prevents attaching a Worker
Custom Domain.

### D-S02: Establish protected identity, payload, and key operations

Configure authentication, payload access and retention controls, database audit
protections, signing-key lifecycle, and distribution of versioned verifier trust
bundles.

### D-S03: Pilot caller integration and recovery behavior

Integrate a PGH caller and one independent verifier, then exercise online
request handling, matching-payload offline verification, withdrawal, and
compromised-key status handling.

## Acceptance criteria

### D-AC01: Ownership and deployment boundary are explicit

The repository, Cloudflare environment, operating owner, support boundary, and
`gate.silvermoon.work` custom-domain configuration are documented and approved
by the responsible stakeholders; prove this with repository/configuration
evidence, zone and DNS eligibility, and owner sign-off. A successful deployment
and DNS resolution are required before claiming the hostname is live.

### D-AC02: Consumers can verify decisions safely

A deployed pilot blocks on pending requests and releases only for an
authenticated decision credential whose signature and expected payload digest
match; prove this with end-to-end traces and independent offline verifier
results that identify the trust-bundle version.

### D-AC03: Operational safeguards are exercised

Operators demonstrate access auditing, payload protection, key rotation and
compromised-key handling, plus restoration of request/audit state; prove this
with reviewed runbooks and recorded recovery exercises.
