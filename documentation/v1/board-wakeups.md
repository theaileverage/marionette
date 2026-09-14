# Board wakeups

How a committed change reaches the project watcher, and what happens when it does
not. This covers the local wake transport, the two watcher schedules, and the
native observation cost of a watcher pass.

## The shape

```
CLI / SDK  --write (commits)--> SQLite (durable truth)
     |
     +--poke (local socket, after the commit)--> watcher
                                                   |-- delivery schedule: pokes + durable state + fallback timer
                                                   '-- reconcile schedule: periodic native observation
```

Storage never depends on transport. A poke is a hint that durable state changed;
losing one delays a wake by at most the fallback interval and can never lose it,
because the rows the watcher reads are already committed.

## The poke

A poke is attention, never authority. The datagram names one project and carries
nothing else: no credentials, no context path, no post content. The watcher
re-reads the database to decide what to do, so a poke cannot instruct it, cannot
widen anybody's access, and cannot be replayed into a second effect.

That is why **any role may poke**, including a worker. A worker still may not own
or spawn a watcher: `ensureWatcher()` pokes for everyone and spawns only for a
non-worker session. A worker on a project with no live watcher therefore leaves
its unread work durable and waits for a controller command to start one; the
wake is delayed, never dropped.

| Property | Value |
|---|---|
| Transport | `AF_UNIX` stream socket (`node:net`). Node's `node:dgram` is UDP only, so there is no datagram option without a native dependency. |
| Payload | One JSON line, `{"v":1,"projectId":"..."}`, refused above 512 bytes on both sides |
| Permissions | Socket `0600` by `chmod` after bind, in a `0700` directory. No process-global `umask` is touched. |
| Sender failure | Always `false`, never a throw and never a block. An absent watcher, a saturated backlog and a refused connection are indistinguishable and all harmless. |
| Coalescing | Many pokes collapse into one boolean before the next pass reads it |
| Backpressure | Bounded accept queue; each connection is read to a byte cap and then destroyed |

### Where the endpoint lives

`wakeSocketPath(stateDirectory, projectId)` is a pure function of the project, so
a sender and a receiver always agree without consulting each other.

It prefers `<stateDirectory>/wake.sock`. The kernel caps a socket address far
below `PATH_MAX` — 104 bytes including the terminator on Darwin, measured, not
assumed: binding succeeds at exactly 104 and fails `EINVAL` at 105 — and
`projects/<projectId>/wake.sock` alone costs 46 of them. For the default state
root that leaves the preferred path sitting exactly on the limit, so a longer
home directory name would lose the transport entirely.

When the preferred path does not fit, the endpoint falls back to
`<stateRoot>/wake/<first 16 hex of sha256(projectId)>.sock`, which costs 27
bytes. Same private state root, same `0700`/`0600` permissions, tens of bytes of
headroom. If neither path fits, the listener reports `unavailable` and the
watcher runs on its fallback timer alone.

### Who may hold the endpoint directory

Before binding, the directory holding the endpoint is checked with `lstat`,
never `stat`: it must be a real directory, not a symbolic link, owned by this
user, and unreadable and unwritable by anyone else. Following a link silently is
how a private endpoint stops being private. A directory that fails any of those
degrades to the fallback timer rather than binding anyway.

### Rebinding after a crash

`EADDRINUSE` means the path is occupied, not that the occupant is dead. Removing
it is destructive, so it happens only on proof:

| Evidence | Action |
|---|---|
| Path is not a socket | Leave it. Degrade to the fallback timer. |
| Connect succeeds | Another owner is live. Never displace it; degrade. |
| Connect fails `ECONNREFUSED` | Nobody is listening on a socket. Remove and rebind. |
| Timeout, `EACCES`, anything else | Inconclusive. Leave it. Degrade. |

A timeout or a permission error can come from an endpoint that is perfectly
alive, so neither may be read as absence.

## The two schedules

One process, two independent schedules, one shared stop.

**Delivery** runs on pokes and on durable state. Each pass consumes the coalesced
signal *before* reading durable state, polls once, and then asks the watcher's
pending-work predicate whether anything is still queued. Consuming the signal
first is what closes the catch-up race: anything committed after the read pokes
an already-armed listener, so the next wait returns immediately rather than
sleeping through it.

**Reconciliation** observes active attempts on its own timer. It is never behind
delivery work, so a blocked recipient cannot delay an observation, and a slow
observation cannot delay a wake.

Either schedule failing stops both. Losing the ownership generation surfaces as a
failure from the watcher's own owner check, so the watcher fails closed rather
than continuing to deliver without a claim.

### Intervals

| Interval | Default | Meaning |
|---|---|---|
| `fallbackIntervalMs` | 15s | Longest a quiet watcher sleeps. Bounds the cost of every lost poke. |
| `reconcileIntervalMs` | 5s | Cadence for observing attempts that are already running |
| Start-progress cadence | 1s | Used instead while any attempt is still owed a launch or a prompt |
| Busy retry | 250ms, doubling to 5s | Used when a pass found work but settled none |
| `minDeliveryIntervalMs` | 25ms | Floor on the delivery pass rate, whatever the signal rate |

The busy retry exists because `pollOnce()` returning 0 means one recipient was
not ready, not that the queue is empty — another recipient may be. Sleeping the
full fallback interval there would starve everyone behind the first busy one.
This is an interim bound owned by the watch loop; a delivery layer that iterates
recipients fairly, or reports the next ready one, supersedes it.

A poke is cheap but not free: each pass costs a claim attempt and a read, so an
unbounded signal rate would become an unbounded transaction rate. The minimum
pass interval bounds that without a queue. It costs nothing after a long wait,
because it measures elapsed time rather than sleeping unconditionally, and it is
short enough that a wake still feels immediate. It is also what makes a burst
collapse at loop level: signals that land inside one interval cost one pass.

## The pending-work predicate

The idle timer asks `Watcher.hasPendingWork()`: a cheap read that performs no
native observation and settles nothing. `false` must mean it is safe to idle out.

It is injected into `watch({ pendingWork })` rather than discovered by sniffing
the watcher for the method, so the seam is visible and the timer cannot silently
start expiring with work still queued. Until the watcher declares it, the loop
reads the delivery rows directly.

## Native observation cost

A watcher pass used to call `runtime.start(id)` and then `runtime.reconcile(id)`
for every active attempt. Past launch, `start()` only falls through to
`inspect()`, and `reconcile()` inspects again — two full observations, four
subprocess spawns and two fsynced writes per attempt per pass, for one
attempt's worth of information.

`Runtime.needsStartProgress(id)` is true only for `admitted` and `launched`.
The loop calls `start()` only when it is, and always calls `reconcile()`.
Measured through a counting adapter: **2 observations per pass become 1**.

`launched` matters and is tested: `start()` carries an admitted attempt all the
way to `active` in one call, so an attempt is only ever seen in `launched` when a
process was lost between its launch and its prompt. It must still be offered
start progress on the next pass.

Endpoint identity (`lsof`, `ps`) is deliberately **not** cached. Every native
observation still verifies the socket, the server start token and the protocol
from scratch. Caching it would buy two subprocess spawns per observation on top
of a reduction that has already taken an idle watcher to zero observations and a
running attempt from two per second to one per five seconds, and it would let a
Herdr server that died and was replaced inside the cache window be observed as
the same server. Reconciliation acts on observations, so that is attempt state,
and it is not worth the margin.

## What is deliberately absent

- **No WebSocket, SSE or HTTP server.** The transport is a local socket in the
  user's own state directory.
- **No Herdr status-event subscription.** `pane.agent_status_changed` would
  remove the polling entirely, but it is unverified against a live Herdr server
  in this repository. The poke-plus-timer path stands alone and must keep doing
  so whether or not events are added later.
- **No prompt replay.** A poke is freely repeatable because it is content-free
  and has no effect of its own. A native prompt is not, and nothing here touches
  that path.

## Verifying it

The claims above are tested in `tests/v1/wake.test.ts` (transport) and
`tests/v1/watch-lifecycle.test.ts` (loop), and mirrored in the Effect port at
`effect-port/tests/wake-effect.test.ts`. Both suites report measured numbers as
test diagnostics rather than asserting performance targets: latency, pass counts
and observation counts are properties of the host that ran them.
