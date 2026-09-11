You are a principal/staff-level distributed-systems engineer, security engineer, SRE, database engineer, and SDK/platform reviewer.

I built the system described in the attached architecture/design document. Review the ACTUAL implementation/codebase against the design and determine whether it is genuinely production-ready.

Do NOT give me a generic checklist. Do NOT assume the design is correct just because it is detailed. Your job is to aggressively try to find reasons this system should NOT ship.

## Primary objective

Answer one question:

> **If I put real production traffic and real customers on this tomorrow, what is most likely to break, silently return incorrect flag values, create a security incident, corrupt data, lose configuration, or make recovery from an incident painful?**

Give me a hard verdict:

- 🟢 READY — safe to launch
- 🟡 READY WITH CONDITIONS — launch is acceptable only after specific blockers are addressed
- 🔴 NOT READY — one or more critical issues must be fixed before production

Do not soften the verdict.

---

# 1. Establish implementation reality

First compare the design document against the actual repository.

For every major component, classify it as:

- Implemented and verified
- Implemented but incomplete
- Implemented but materially different from design
- Stub/mock/fake
- Missing
- Cannot verify from available code/tests

Pay special attention to claims in the design that sound like guarantees.

Examples:

- synchronous, in-process evaluation
- no network call per evaluation
- last-known-good snapshots
- caller-default fallback
- deterministic percentage bucketing
- cross-language conformance
- SSE patch replay/resume
- Redis loss recovery
- Postgres as source of truth
- client/server tier security boundary
- secure mode
- external segment resolution without evaluation-path I/O
- fail-closed segment behavior
- partition lifecycle
- single-writer rollups
- auditability
- production dry-run/change controls
- chaos-tested failure behavior

If the implementation does not prove a claim, mark it as UNVERIFIED rather than giving it credit.

---

# 2. Production blockers

Find every issue that could reasonably cause:

### P0 — launch blocker

Examples:

- incorrect flag evaluation
- security boundary bypass
- tenant isolation failure
- secret/key leakage
- production configuration being unintentionally exposed to browsers
- stale or incorrect values surviving longer than intended
- corrupted snapshots
- inconsistent rollout bucketing
- lost configuration
- unrecoverable database state
- data races causing incorrect evaluations
- request-path blocking/I/O
- unbounded memory growth
- event/queue behavior causing the control plane to become unavailable
- catastrophic migration failure
- inability to roll back safely
- a kill switch not actually behaving as a kill switch

### P1 — serious production issue

Things that don't necessarily prevent launch but would make operating the system dangerous or unreliable.

### P2 — important hardening

Issues worth fixing but which shouldn't block initial production use.

For every issue provide:

1. Severity
2. Exact component/file/function
3. What is wrong
4. Why it matters in production
5. Concrete failure scenario
6. How likely it is
7. How difficult it is to fix
8. Exact recommended fix
9. Test that should be added to prevent regression

---

# 3. Evaluation engine audit

Treat the evaluator as the most critical piece of the system.

Audit:

- precedence semantics
- flag-not-found behavior
- disabled flags
- caller defaults
- malformed snapshots
- malformed rules
- variation references
- targeting
- rule ordering
- AND/OR semantics
- negation
- missing attributes
- type mismatches
- multi-valued attributes
- dates
- semantic versions
- regex behavior
- regex/ReDoS protection
- segment matching
- recursive segment evaluation
- prerequisite evaluation
- prerequisite cycles
- recursion/depth limits
- rollout boundaries
- zero-weight variations
- 100% rollout
- 0% rollout
- missing bucketing attributes
- context normalization
- multi-context behavior
- Unicode
- unusual strings
- extremely large contexts
- pathological inputs
- snapshot corruption

Try to construct inputs that cause the evaluator to:

- throw
- hang
- allocate excessively
- return the wrong variation
- return a misleading reason
- bypass targeting
- accidentally enable a flag

The evaluator is explicitly designed never to throw and to return the caller's default on errors. Verify that this is actually true.

---

# 4. Percentage rollout correctness

Audit the complete bucketing implementation.

Verify:

- exact hash algorithm
- UTF-8 encoding
- seed handling
- salt handling
- integer arithmetic
- boundary behavior
- weight validation
- sum-to-100000 invariant
- deterministic assignment
- cross-process determinism
- cross-runtime determinism
- cross-language determinism
- behavior around bucket 0
- behavior around bucket 99999
- non-ASCII identifiers
- very long identifiers

Do not trust benchmark numbers in the design. Reproduce them.

Also verify that changing any supposedly immutable bucketing parameter cannot silently re-bucket an existing production population.

---

# 5. Snapshot and configuration correctness

Audit the entire lifecycle:

Postgres → compiler → Redis → SSE/polling → SDK → in-memory snapshot → evaluator.

Look for:

- partial snapshots
- stale snapshots
- snapshot/version races
- version rollback
- lost updates
- concurrent compilation
- cache stampedes
- invalidation races
- snapshot corruption
- incompatible snapshot versions
- patch ordering problems
- duplicate patches
- missing patches
- patch replay gaps
- full-snapshot fallback
- process restart behavior
- disk persistence corruption
- atomicity of snapshot replacement

Prove that a bad control-plane deployment cannot cause every SDK to simultaneously lose a previously valid configuration.

---

# 6. SSE and streaming audit

Treat SSE as a distributed protocol, not merely an HTTP endpoint.

Test:

- initial connection
- reconnect
- Last-Event-ID
- duplicate events
- missing events
- out-of-order events
- expired patch history
- Redis restart
- API node restart
- load balancer behavior
- connection draining
- deploys with thousands/millions of connections
- slow clients
- dead clients
- half-open connections
- connection limits
- heartbeat behavior
- backpressure
- memory per connection
- reconnect storms
- thundering herd after control-plane recovery

Determine whether a mass reconnect can itself take down the system.

---

# 7. Client-tier security audit

Assume the browser/mobile client is hostile.

Attempt to:

- obtain the full ruleset
- enumerate hidden flags
- read non-client-available flags
- impersonate another user/context
- replay signatures
- extend signature expiration
- bypass secure mode
- exploit unsigned contexts
- switch environments
- use a client key against another environment
- abuse `/v1/client/state`
- abuse SSE
- brute-force identities
- exploit context hashing
- exploit fingerprint caching
- extract sensitive targeting information
- exploit error messages
- exploit debug endpoints

Pay particular attention to:

- SDK key scope
- tenant/environment isolation
- server vs client key separation
- HMAC implementation
- constant-time comparison
- expiry handling
- maximum TTL
- key rotation
- replay window
- revocation behavior
- rate limiting

The design explicitly treats secure mode as a security boundary and uses expiring signatures; verify the implementation rather than accepting the specification at face value.

---

# 8. Multi-tenancy and authorization

Assume one customer is actively trying to access another customer's data.

Audit EVERY API path and repository query for:

- project isolation
- environment isolation
- flag isolation
- segment isolation
- audit-log isolation
- SDK-key isolation
- access-token scoping
- MCP access
- debug/evaluation access
- scheduled changes
- change requests
- rollback
- metrics
- analytics

Look specifically for IDOR/BOLA vulnerabilities.

Do not merely check authentication. Verify authorization at the data-access boundary.

---

# 9. Database audit

Review the actual migrations/schema, not just the TypeScript schema.

Audit:

- foreign keys
- uniqueness
- missing composite constraints
- orphan creation
- delete cascades
- update races
- indexes
- query plans
- lock behavior
- transaction boundaries
- isolation levels
- migrations on large production tables
- rollback strategy
- concurrent writes
- optimistic concurrency
- version increments
- scheduled changes
- audit-log integrity

For every high-volume query, determine whether the required indexes actually exist.

Identify queries that will work perfectly with 10k rows but collapse at:

- 1M flags/records
- 10M segment members
- 100M analytics rows
- thousands of environments
- millions of evaluations/sec

---

# 10. PostgreSQL partitioning and analytics

Audit the partitioned evaluation-summary system extremely aggressively.

Verify:

- partition creation
- pg_partman configuration
- pg_cron dependency
- retention
- premade partition runway
- timezone/DST behavior
- missing partitions
- insert behavior when a partition is missing
- partition creation failure
- retention failure
- index strategy
- rollup correctness
- duplicate event handling
- late events
- shard ownership
- shard rebalancing
- concurrent rollup writers
- HLL merge correctness
- idempotency
- recovery from Redis loss
- DLQ behavior

Verify that the claim "analytics loss is acceptable but evaluation correctness is not" is actually enforced architecturally.

---

# 11. Redis audit

Assume Redis disappears completely.

Determine:

- what is recoverable
- what is permanently lost
- recovery time
- recovery load
- whether recovery can overload Postgres
- whether recovery causes a reconnect storm
- whether snapshots can be reconstructed safely
- whether pub/sub loss creates stale SDKs
- whether patch-history loss is handled correctly
- whether rate-limit state loss creates a security problem
- whether event loss is bounded
- whether segment-cache loss changes evaluation semantics

Then simulate:

1. Redis hard restart
2. Redis data loss
3. Redis network partition
4. Redis slow responses
5. Redis partial availability
6. Redis failover during a flag deployment

---

# 12. Failure-mode and chaos testing

Do not accept "we have a chaos directory" as evidence.

Find the actual tests and determine whether they genuinely exercise:

- control plane unavailable at startup
- control plane dies during traffic
- Redis dies during traffic
- Postgres dies during traffic
- SSE disconnects
- patch history expires
- malformed snapshot arrives
- snapshot version regresses
- concurrent flag updates happen
- SDK restarts with stale persisted state
- segment provider disappears
- event queue fills
- rollup worker dies
- scheduler dies
- API node dies
- multiple API nodes disagree
- network partitions
- reconnect storms

For each scenario state:

- expected behavior
- actual behavior
- whether it was tested
- whether the test would catch a regression

---

# 13. Performance and capacity

Benchmark the actual implementation.

Do not rely on design-document numbers.

Measure separately:

- evaluation without hashing
- evaluation with hashing
- targeting
- prerequisites
- segment lookup
- large snapshots
- snapshot replacement
- context normalization
- SSE fan-out
- client-tier evaluation
- `/v1/client/state`
- analytics ingestion
- rollup
- snapshot compilation

Measure:

- p50
- p95
- p99
- p99.9
- throughput
- CPU
- heap
- GC
- allocations
- memory per connection

Then estimate realistic capacity for:

- 1M evaluations/sec
- 10M evaluations/sec
- 100k server SDK connections
- 1M client connections
- 10k environments
- 100k flags
- 1M-member segments
- 10M-member segments

Identify the first bottleneck.

---

# 14. Memory safety

Calculate worst-case memory usage for:

- snapshots
- segments
- cuckoo filters
- roaring bitmaps
- context caches
- client fingerprints
- SSE connections
- event buffers
- Redis data
- persisted snapshots

Look for:

- unbounded Maps/Sets
- unbounded caches
- forgotten TTLs
- connection-associated state
- large JSON payloads
- pathological segment sizes
- oversized contexts
- event batching
- reconnect state

Find every path where an attacker or customer can cause memory growth.

---

# 15. API and input hardening

Audit all public endpoints.

Check:

- authentication
- authorization
- schema validation
- body-size limits
- query limits
- pagination
- rate limiting
- timeout behavior
- request cancellation
- malformed JSON
- oversized JSON
- deeply nested JSON
- regex payloads
- huge arrays
- huge segment imports
- huge flag configurations
- replayed requests
- idempotency
- CSRF where relevant
- SSRF where relevant
- path traversal
- prototype pollution
- SQL injection
- Redis command injection
- log injection

---

# 16. Operational readiness

Determine whether an actual small engineering team can operate this at 3am.

Check:

- health endpoint
- liveness
- readiness
- metrics
- structured logging
- tracing
- alerting
- dashboards
- useful error codes
- correlation/request IDs
- deployment strategy
- graceful shutdown
- rolling deployments
- migrations
- rollback
- backup/restore
- disaster recovery
- RPO
- RTO
- capacity alerts
- Redis alerts
- Postgres alerts
- partition runway alerts
- event backlog alerts
- SSE connection alerts
- stale snapshot alerts
- snapshot age
- SDK version skew

For every critical alert, ask:

> "Would this alert fire BEFORE users notice incorrect flag behavior?"

---

# 17. Observability correctness

Audit whether the telemetry itself can lie.

Check:

- metric cardinality
- label explosion
- tenant IDs in labels
- flag keys in labels
- user/context IDs in metrics
- sensitive data in logs
- audit-log completeness
- evaluation reason accuracy
- dropped-event accounting
- sampled analytics
- clock skew
- timestamps
- duplicate metrics
- missing metrics during outages

Ensure observability cannot become the next outage.

---

# 18. Governance and change safety

Audit:

- production dry-run behavior
- approval workflow
- scheduled changes
- audit logging
- revert
- kill switch
- concurrent edits
- stale UI state
- optimistic concurrency
- accidental overwrites
- token identity
- MCP changes
- automation/API changes

Try this scenario:

> Two engineers edit the same production flag simultaneously. One changes targeting. The other changes rollout. Both save successfully.

Determine exactly what happens.

Then:

> An operator performs a kill switch while another deployment is publishing a snapshot.

Determine exactly what happens.

---

# 19. SDK lifecycle

Audit the SDK as a library that will live inside somebody else's application.

Check:

- initialization
- startup behavior
- `ready()`
- bootstrap
- persistence
- corrupted persisted state
- reconnects
- shutdown
- multiple SDK instances
- multiple environments
- Node versions
- edge runtimes
- browser compatibility
- bundling
- tree shaking
- dependency leakage
- synchronous API behavior
- accidental promises
- global state
- timers
- event listeners
- process shutdown behavior

Verify that importing the server SDK does not accidentally pull control-plane dependencies into customer applications.

---

# 20. Package and supply-chain security

Audit:

- dependency count
- transitive dependencies
- dependency vulnerabilities
- lockfile
- npm package contents
- accidental secrets
- source maps
- build reproducibility
- package exports
- ESM/CJS compatibility
- generated files
- malicious install scripts
- provenance/signing if applicable
- semver/version compatibility
- backwards compatibility

---

# 21. Testing quality

Determine actual test coverage by behavior, not line count.

Identify missing tests for:

- evaluator edge cases
- cross-language conformance
- Unicode
- rollout boundaries
- cuckoo filter correctness
- large segment imports
- snapshot races
- version ordering
- SSE replay
- Redis failure
- Postgres failure
- migrations
- authorization
- secure mode
- tenant isolation
- concurrency
- load
- memory
- chaos

Pay special attention to tests that merely test mocks instead of real Postgres/Redis behavior.

---

# 22. Design contradictions

Search the entire design for contradictions.

Examples of questions to ask:

- Does any supposedly synchronous path actually perform I/O?
- Does any "last known good" state accidentally become permanently stale?
- Does any fail-closed behavior contradict availability requirements?
- Does any fail-open behavior contradict security requirements?
- Can client-side caching return another user's values?
- Can a snapshot be internally consistent while being semantically stale?
- Can Redis loss cause a Postgres thundering herd?
- Can a rollout be deterministic while context normalization is not?
- Can segment membership be stale enough to violate the intended targeting guarantee?
- Can a kill switch be delayed by patch fan-out?
- Can analytics load affect evaluation latency?
- Can one tenant create resource exhaustion for all tenants?

---

# 23. Adversarial production scenarios

Walk through these end-to-end and tell me exactly what happens:

### Scenario A
Production flag must be turned OFF immediately while Redis is down.

### Scenario B
Postgres is unavailable for 30 minutes.

### Scenario C
Redis is completely wiped.

### Scenario D
An API node sends an older snapshot after a newer one.

### Scenario E
100,000 SDKs reconnect simultaneously after a network outage.

### Scenario F
A 10-million-member segment is imported.

### Scenario G
A segment import occurs while a flag targeting that segment is being changed.

### Scenario H
A production SDK has a corrupted persisted snapshot.

### Scenario I
A malicious browser attempts to impersonate another customer.

### Scenario J
Two production changes race against each other.

### Scenario K
The analytics database is completely broken for 24 hours.

### Scenario L
A future SDK written in Go consumes snapshots generated by the current implementation.

### Scenario M
A customer creates pathological targeting rules intended to consume CPU.

### Scenario N
A customer accidentally creates a flag with a massive number of rules/targets/segments.

For each scenario provide the exact chain of events and final user-visible behavior.

---

# 24. Launch gate

At the end, produce a strict launch gate.

## MUST FIX BEFORE PRODUCTION

Only true blockers.

For each:

- issue
- severity
- evidence
- fix
- required regression test

## SHOULD FIX BEFORE PRODUCTION

Important but not absolute blockers.

## CAN SHIP / POST-LAUNCH

Non-blocking improvements.

## UNVERIFIED CLAIMS

List every important design claim that the current implementation/tests do not prove.

## REQUIRED LOAD TESTS

Give exact tests, traffic levels, duration, and success thresholds.

## REQUIRED CHAOS TESTS

Give exact failure injections and expected outcomes.

## REQUIRED SECURITY TESTS

Give exact attack scenarios and pass/fail criteria.

## REQUIRED OPERATING RUNBOOKS

List the runbooks that must exist before launch.

---

# 25. Final verdict

End with:

### Production Readiness Score

Score these independently from 0–10:

- Correctness
- Reliability
- Security
- Scalability
- Performance
- Data integrity
- Observability
- Operability
- Disaster recovery
- Testing confidence
- SDK/library safety
- Governance/change safety

Then give:

**Overall: X/10**

**Verdict: READY / READY WITH CONDITIONS / NOT READY**

Then answer:

> **If this went into production tomorrow, what are the top 5 things most likely to bite us?**

Be blunt.

Do not praise the architecture unless the implementation proves the claim.
Do not treat documentation as implementation.
Do not treat tests existing as tests being sufficient.
Do not invent evidence.
If you cannot verify something, explicitly say **UNVERIFIED**.
Prioritize real production failure modes over stylistic code-quality comments.