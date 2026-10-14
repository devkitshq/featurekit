# Alerts

Every alert here answers one question before it earns its place:

> **Would this fire *before* a user sees an incorrect flag value?**

An alert that only fires afterwards is a postmortem input, not an alert. Those
are marked as such rather than deleted, because knowing which of your alerts are
lagging indicators is itself operational information.

Thresholds assume the defaults in `docs/control-plane/configuration.md`.

---

## Page — wake someone up

### `featurekit_snapshot_age_seconds > 300` for any environment

Changes are not reaching this node. Fires **before** users see anything wrong,
because the currently-serving configuration is still valid — it is just frozen.

```promql
max by (environment) (featurekit_snapshot_age_seconds) > 300
```

Runbook: *Snapshot age is climbing.*

### `featurekit_sdk_default_served_total` rising across a fleet

SDKs are serving caller defaults, which means they hold no usable snapshot. This
is the closest thing to a direct "users are getting wrong values" signal.

```promql
sum(rate(featurekit_sdk_default_served_total[5m])) > 0
```

Fires **as** users are affected. Lagging by construction; it is the backstop for
everything the earlier alerts missed.

### `featurekit_partition_runway_days < 2`

Analytics ingest will begin failing when the last premade partition ends.

```promql
min(featurekit_partition_runway_days) < 2
```

Fires days early. Runbook: *Partition runway below two days.*

### Readiness failing on more than one node

```promql
count(up{job="featurekit"} == 0) > 1
```

### `featurekit_snapshot_compile_failures_total` rising

A configuration that will not compile. The previous snapshot keeps serving, so
this fires before any user-visible effect — but changes are silently not landing.

```promql
increase(featurekit_snapshot_compile_failures_total[10m]) > 0
```

---

## Ticket — look at it during business hours

### Degraded snapshot serves

The snapshot store could not be read and nodes are serving from memory or a
fresh compile. Correct behaviour, and usually the first sign of database
trouble.

```promql
sum(rate(featurekit_snapshot_degraded_serves_total[5m])) > 0
```

### SSE connections near the cap

```promql
featurekit_stream_connections > 0.8 * <MAX_STREAM_CONNECTIONS>
```

### Rollup lag

```promql
featurekit_rollup_lag_seconds > 900
```

### Dead-letter queue receiving batches

```promql
increase(featurekit_rollup_dlq_total[30m]) > 0
```

Split by `reason`; `missing_partition` should page rather than ticket, since it
means the partition alert above was missed.

### Event drops sustained

```promql
sum(rate(featurekit_events_dropped_total[15m])) > 0
```

Analytics loss is accepted, but a *sustained* rate means the buffer is
permanently undersized rather than absorbing a spike.

### Rate limiting rejecting real traffic

```promql
sum by (route) (rate(featurekit_rate_limited_total[5m])) > 1
```

Either an abusive caller or a limit set too low for a legitimate one. Both are
worth a look; neither is a page.

### 5xx rate

```promql
sum(rate(featurekit_http_requests_total{status="5xx"}[5m]))
  / sum(rate(featurekit_http_requests_total[5m])) > 0.01
```

---

## Deliberately absent

**Per-flag alerting.** There is no `featurekit_evaluations_total{flag_key=...}`
series, and there must not be: one time series per flag per variation per reason
is a cardinality explosion that takes down the monitoring system first and this
process second (§17). Per-flag numbers live in `evaluation_summaries`, which is
partitioned and retained on purpose.

**Per-tenant alerting.** Same reason. `environment` is the only tenant-shaped
label anywhere, it is bounded by `BoundedLabels`, and it collapses to `"other"`
past the ceiling rather than growing without limit.

**Anything labelled with a context key.** A context key identifies an end user.
It appears in no metric, by construction.

---

## Dashboard panels

The minimum set that makes the alerts above interpretable:

1. Snapshot age per environment (max), with the 300s threshold drawn.
2. Snapshot version per environment — a flat line during a deploy window is the
   symptom of propagation having stopped.
3. Compile duration p50/p99, and compile failures.
4. Degraded serves by source (`memory` / `postgres`).
5. SSE connections by tier, against the configured caps.
6. HTTP request rate and duration p99 by route pattern.
7. Rate-limited requests by route.
8. Rollup lag, rows written, DLQ by reason.
9. Partition runway days.
10. Event drops by reason.
