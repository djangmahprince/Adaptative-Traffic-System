# Traffic Flow Logic Specification — Vehicle Behavior Engine

Reference document for anyone (human or AI) working on how vehicles move, turn, queue, and avoid
collisions in the dashboard's live intersection view. Source of truth for everything below is
`dashboard/static/live.js` as of this writing. This is a companion to `PROJECT_LOGIC_SPEC.md` (which
covers the traffic-*signal* logic, hardware protocol, and pin assignments) — this document covers only
*vehicle* behavior: the rules that decide where each car is, how fast it's going, and when it's allowed
to move.

## 1. Governing principle

**The traffic light is the sole authority over whether a vehicle may enter the intersection.** The
Random Forest model that predicts congestion (see `PROJECT_LOGIC_SPEC.md` §1) has no involvement here
whatsoever — it never sees individual vehicles and never influences their movement. A vehicle's motion is
decided entirely by: the current signal color for its lane, the vehicle directly ahead of it, permissive
left-turn yield rules, and whether its destination lane has room. Nothing else — not aggressiveness, not
randomness beyond initial route choice — enters into a movement decision.

Every vehicle is re-evaluated **independently, every animation frame** (`requestAnimationFrame`, capped
to a 50ms max step to avoid a huge jump after a tab was backgrounded): each one checks its own light,
checks the car ahead of it, and decides a target speed. There is no central "traffic simulator" making
decisions on behalf of vehicles — the safe, orderly behavior that results (queuing, staggered discharge,
gaps that never close to zero) is an *emergent property* of every vehicle following the same simple local
rules, not scripted behavior.

## 2. Vehicle representation

Each vehicle is a single JS object with (relevant fields):

| Field | Meaning |
|---|---|
| `lane` | Origin lane, one of `A`/`B`/`C`/`D` |
| `movement` | `straight` / `left` / `right`, chosen once at spawn |
| `exitDir` | Compass direction (`east`/`west`/`north`/`south`) it will be traveling after crossing |
| `laneSide` | `inner` or `outer` — which of the two physical lanes it occupies (see §7) |
| `t` | Path-progress parameter, roughly 0 (spawn, off-screen) → 1 (despawn, off the far edge). This is the *only* position variable — everything else (screen x/y, rotation) is a deterministic function of `t` |
| `v` | Current speed, in `t`-units per second |
| `state` | One of `WAITING` / `QUEUED` / `MOVING` / `STOPPING` / `TURNING` / `EXITING` — a diagnostic label; see §4 |

**Important distinction:** `t` positions the vehicle's *center* (the sprite is a 24-unit-long rectangle
straddling the origin locally). Every rule about stopping at a line or not overlapping another car has to
convert between "center position" and "front bumper position" — this conversion is what an earlier
version of this logic got wrong (see §5).

## 3. Road and intersection geometry (brief — full detail in `PROJECT_LOGIC_SPEC.md`)

The intersection matches the physical hardware prototype: lanes A/C (the horizontal road) are a real
two-lane-each-way carriageway; lanes B/D (the vertical road) are a single lane each way. This makes the
junction box a **rectangle**, not a square — its width is set by B/D's carriageway (46 units total, so
`BOX_HALF_X = 23`), its height by A/C's carriageway (92 units total, so `BOX_HALF_Y = 46`).

Because the box isn't symmetric, **the fraction of a vehicle's path spent "before the stop line" differs
by which axis it travels on** — A/C vehicles cross a short (46-unit) box quickly, B/D vehicles cross a
tall (92-unit) box more slowly:

```
PATH_LEN  = 384          (edge-to-edge travel distance, same for every direction)
STOP_T_X  ≈ 0.4401        (A/C: fraction of path at the stop line)
CROSS_T_X ≈ 0.5599        (A/C: fraction of path where the box is fully cleared)
STOP_T_Y  ≈ 0.3802        (B/D: fraction of path at the stop line)
CROSS_T_Y ≈ 0.6198        (B/D: fraction of path where the box is fully cleared)
```

Every vehicle's "am I at the stop line yet" check uses whichever pair matches its own axis
(`stopTFor(dir)` / `crossTFor(dir)`) — using a single shared fraction for both axes would put one axis's
stop line in visibly the wrong place.

## 4. Vehicle state machine

Six states, purely diagnostic labels (the actual physics is entirely gap/ceiling-driven — see §6 — and
does not depend on which label is currently assigned; the label just makes the *result* legible):

| State | Meaning | Entered when |
|---|---|---|
| `MOVING` | Driving freely, unobstructed | Before the stop line, light allows entry, not yet at the speed-cap limit stop |
| `STOPPING` | Actively decelerating toward a binding constraint | Before the stop line, still moving but below a small speed threshold, on the way to stopping |
| `QUEUED` | Fully stopped, behind another vehicle (not at the front) | Blocked from entering AND the car-ahead gap is the tighter constraint than the stop line |
| `WAITING` | Fully stopped, at the front of the queue | Blocked from entering AND the stop line itself is the tighter constraint |
| `TURNING` | Inside the protected intersection box | `t` has passed the stop line (specifically, once the *front bumper* — not the center — reaches it; see §5) |
| `EXITING` | Past the box, driving to the far edge | `t` has passed the "fully cleared" point |

Transitions are recomputed fresh every frame from current position/speed/signal — there's no separate
transition table to get out of sync with the underlying physics.

## 5. Stop-line compliance — front bumper, not center

**Rule: the front bumper must never cross the stop line while the light requires stopping, and must leave
a small realistic gap behind it — never touch or overlap it.**

The sprite is 24 units long, centered on `t`. Naively clamping the *center* position to just short of the
stop line's coordinate leaves the front bumper (12 units ahead of center) overshooting the line by ~10
units — this was a real bug, fixed by explicitly accounting for vehicle length:

```
CAR_LENGTH_T     = 24 / 384              (sprite length, in t-units)
STOP_LINE_GAP_T  = 8 / 384               (desired gap between front bumper and the painted line)
STOP_MARGIN_T    = CAR_LENGTH_T/2 + STOP_LINE_GAP_T   (how far the CENTER must stop short of the line)

frontCommitT = stopT - CAR_LENGTH_T/2    (once t reaches this, the front bumper is AT the line —
                                           the vehicle is considered committed and can never be
                                           re-gated again, even if the light changes back to red)
stopCeilingT = stopT - STOP_MARGIN_T     (where a BLOCKED vehicle's center actually halts)
```

A vehicle already past `frontCommitT` when the light changes is never stopped mid-box — it always
finishes crossing safely (this is what allows a vehicle already committed on yellow, or even on a
just-turned-red edge case, to clear the intersection rather than stopping inside it).

## 6. Car-following / safe distance

**Rule: a vehicle must never overlap the vehicle ahead of it, and must maintain a realistic gap.**

```
BUMPER_GAP_T = 10 / 384                        (desired bumper-to-bumper gap)
SAFE_GAP_T   = CAR_LENGTH_T + BUMPER_GAP_T     (equivalent CENTER-to-center spacing, ≈34 units)

followCeiling = leaderT - SAFE_GAP_T           (this vehicle's t can never exceed this)
```

Every frame, vehicles within the same following-chain (§7) are sorted leader-first, and **each follower's
ceiling is computed from a snapshot of positions taken at the START of that frame**, not from positions
already updated earlier in the same frame. This detail matters: without it, a gap opening at the front of
a queue would propagate instantly to the back (every car "seeing" the leader's brand-new position in the
same tick), causing the whole queue to accelerate in lockstep on green instead of a realistic staggered
wave. With the snapshot, a follower's speed is naturally capped by how far the *actual*, not-yet-updated
gap to its leader has opened — which is what produces the staggered green-light discharge described in §9
without needing any separate scripted "reaction time" mechanism.

The **overall motion ceiling** for a vehicle in any given frame is the tighter of two constraints:
```
ceiling = min(followCeiling, lineCeiling)
```
where `lineCeiling` is the stop-line constraint from §5 (or infinite if the vehicle isn't blocked by the
light). Position is **hard-clamped** to this ceiling every frame — `car.t = min(nextT, ceiling)` — which
is the actual, unconditional guarantee against overshoot or overlap, independent of how the target speed
was computed.

## 7. Lane discipline

A/C (the wide road) has two real lanes per direction — **inner** (next to the yellow centerline) and
**outer** (next to the curb). B/D (the narrow road) has only one lane per direction, so inner/outer
collapse to the same physical position there.

**Lane assignment (chosen once, at spawn):**
- Left turn → always the **inner** lane (mirrors real driving: you position yourself near the centerline
  before turning left)
- Right turn → always the **outer** lane (curb lane)
- Straight → 50/50 random between inner and outer, so through-traffic naturally uses both lanes rather
  than piling into one

A vehicle keeps the same lane-side label for its entire journey — a left-turner starts in the inner lane
and *exits* into the inner lane of its new direction; same for outer/right. This is also what lets the
following-distance chain (§6) treat the two lanes as independent: a vehicle in the outer lane is never
artificially blocked by a car ahead of it in the inner lane, since they're side-by-side, not nose-to-tail.
On the narrow road, where there's only one physical lane, all of a lane's vehicles share a single
following-chain regardless of their nominal `laneSide` label (since a real single lane can't have two
independent queues sitting side by side).

## 8. Turning — geometry and yield rules

**Movement is chosen once per vehicle at spawn**, from a fixed distribution: 60% straight, 25% left, 15%
right (`MOVEMENT_PROBS`).

### 8.1 Path shape

A turning vehicle's path is three segments: a straight approach (edge → stop line), a quadratic Bézier
curve through the box (stop line → exit entry), then a straight departure (exit entry → far edge). The
curve's **control point** — which determines how tightly or widely it bows — differs by turn type,
matching real driving:

- **Right turns** hug a tight curb radius. The control point is placed at the near corner of the box
  (computed from the origin's stop-line coordinate on one axis and the exit's entry coordinate on the
  other — always perpendicular axes for any turn) — the curve never goes near the box's center.
- **Left turns** sweep more widely, through roughly the middle of the box — which is realistic (a
  permissive left genuinely does cross through the middle) but means two vehicles turning left from
  *opposing* approaches at the same time (a real, common situation — both directions of a road are green
  together) would, if both curves used the exact geometric center as their control point, trace mirror-
  image paths that pass within ~14 units of each other. The fix: each left turn's control point bows 12
  units off-center, in the direction of *that vehicle's own* right-hand perpendicular — which is opposite
  in sign for opposing directions (e.g. south vs. north), so opposing left turns automatically separate
  to either side of center instead of converging on the same point. This mirrors the real-world convention
  that opposing left-turning drivers keep to their own right of the meeting point.

### 8.2 Permissive left-turn yield

**Rule: a left-turning vehicle may not enter the intersection while a straight-through vehicle from the
directly-opposing approach is inside the box or about to be** (there is no protected left-turn arrow and
no dedicated turn lane — this is a standard permissive-left yield).

```
opposingStraightPresent(lane): true if any vehicle in OPPOSING[lane] (A↔C, B↔D) is doing a
'straight' movement and its t is within [stopT - 0.03, crossT + 0.05] — i.e. at, in, or just
about to be in the box.
```

If true, a left-turning vehicle's `mustHoldAtLine` is forced even if the light is green — it waits at the
stop line until the gap clears, exactly like a real driver watching for a safe gap in oncoming traffic.
Right turns and straight-through movements never need this check (a right turn's tight curb path never
crosses the opposing lane's straight path; see §8.1).

## 9. Collision avoidance beyond simple following

Same-lane following (§6) only prevents same-lane, nose-to-tail overlap. Two further mechanisms prevent
the collisions that *would* otherwise happen inside the box between different approaches:

### 9.1 Opposing-left-vs-straight (§8.2, above) — prevented by the yield check.

### 9.2 Right-turn vs. opposing-left-turn converging on the same exit lane

Every green phase runs two approaches at once (e.g. A and C together). Within that pair, a right-turner
from one side and a left-turner from the *other* side can end up feeding the exact same destination lane
(e.g. A-right and C-left both feed into B's lane; A-left and C-right both feed into D's). Right turns
don't yield to opposing traffic like left turns do (§8.2 only applies to left turns, correctly, since real
right turns don't need to), so without a separate check, two vehicles from different approaches could
both commit to entering at the same time, both mid-curve, converging on the same physical lane —
a real, provable collision risk that was found and fixed during testing.

**The fix — exit-lane reservation covering the vehicle's entire transit, not just the tail end:**
```
isExitLaneBlocked(vehicle): true if any OTHER-lane vehicle heading to the SAME exitDir
(and, on the two-lane wide road, the same laneSide) is currently anywhere between having
committed to enter (t >= its own frontCommitT) and being fully clear of the merge zone
(t < its own crossT + EXIT_CLEAR_T, where EXIT_CLEAR_T ≈ 0.08, about 30 units).
```
This means only **one** vehicle, per destination lane (and per physical sub-lane, on the wide road), is
ever mid-transit toward a given exit at a time — a second vehicle heading to the same exit is held at its
own stop line (`mustHoldAtLine`) until the first one has fully cleared. Same-lane traffic is explicitly
excluded from this check (it's already correctly governed by the ordinary following-distance chain in
§6, and would otherwise be redundantly double-gated).

This check applies to **every** movement type, not just right turns — straight-through and left-turning
vehicles are subject to the same "don't enter if your destination lane is still occupied by someone
else's transit" rule, which is also the literal implementation of "don't block the box."

## 10. Speed, acceleration, and braking

No vehicle ever teleports or snaps speed — every change in `v` is bounded:

```
ACCEL = 0.45 t/s²   (smooth acceleration toward a target speed)
DECEL = 0.9  t/s²   (braking — intentionally about 2× accel, like a real driver braking
                      more assertively than they accelerate)

MAX_SPEED_APPROACH = 0.14 t/s   (speed cap while still before the stop line)
MAX_SPEED_OPEN      = 0.30 t/s  (speed cap once inside the box or past it)
```

The **target speed** each frame is the smaller of the relevant cruise cap above and a **safe-stopping-
distance speed cap** derived from the current ceiling (§6):

```
speedCapForGap(gap) = sqrt(2 * DECEL * gap)
```

This is the standard "how fast can I be going right now and still brake to a stop exactly at the ceiling,
given my braking rate" formula — it's what makes a vehicle begin slowing down naturally, well before it
reaches a stop line or the car ahead, rather than cruising at full speed and then stopping abruptly. `v`
moves toward the target at the bounded `ACCEL`/`DECEL` rate, never instantaneously.

## 11. Green-light discharge

**Rule: when a light turns green, queued vehicles do not all move simultaneously — they discharge as a
natural, staggered wave**, matching real traffic engineering (each driver reacts a beat after the one
ahead of them starts moving).

This is *not* implemented as a scripted delay — it emerges directly from §6 and §10 together: the front
vehicle's `followCeiling` is effectively infinite (nothing ahead of it but the now-clear stop line), so it
accelerates immediately. The second vehicle's `followCeiling` is still constrained by the *front vehicle's
pre-frame position* (§6's snapshot detail) — until the front vehicle has physically moved forward enough
to open a meaningful gap, the second vehicle's safe-stopping-distance speed cap stays near zero. As the
gap opens, the cap rises, and the second vehicle starts accelerating a beat behind the first — and so on
down the queue. This was verified directly during testing: on a fresh green, the front vehicle reached
speed 0.187 while the second and third vehicles were still at 0.136 and 0.106 in that same tick.

## 12. Yellow and red compliance

A vehicle's `beforeStop` check (§5) is evaluated fresh every frame from its actual current position — it
is never based on a cached "when did the light change" timestamp. Practically:
- If a vehicle's front bumper has **not yet** reached the stop line when the signal is anything other
  than `GREEN`, it is held (`mustHoldAtLine`) — this covers red and yellow identically (a real yellow
  means "stop if you can do so safely," and this simulation's simplification is that stopping is always
  required unless already past the line, which is a safe, conservative interpretation).
- If a vehicle's front bumper **has already** passed the stop line (`t >= frontCommitT`), it is
  permanently past the gating check for the rest of its journey — the light changing behind it has no
  further effect. This is what guarantees a vehicle already committed to crossing always finishes safely,
  rather than ever stopping inside the box.

## 13. Emergency vehicles

Emergency-lane vehicles are recolored (visually, for the frontmost queued vehicle in that lane only —
real sensor data marks a *lane* as having emergency priority, not an individual vehicle) but are **not**
given any different movement rules. The reason no special-case movement logic is needed: by the time a
lane's signal actually shows the emergency `GREEN`, every conflicting direction is already `RED` (the
signal FSM guarantees this — see `PROJECT_LOGIC_SPEC.md` §4), so the ordinary light-following rules
already produce correct, conflict-free behavior for the emergency lane without any extra code. The one
exception: the exit-lane reservation check (§9.2) is bypassed for the currently-active emergency lane, so
a lingering, still-exiting vehicle from a just-ended phase can't hold up the emergency vehicle's own
passage.

## 14. Digital-twin synchronization

**Rule: the number of vehicles rendered per lane must always match the sensor-reported `vehicle_count` for
that lane** (whether from real hardware or the simulator/scenario generator).

Vehicles are spawned toward the target count opportunistically (up to 2 per frame, capped at `MAX_CARS_SHOWN
+ 2` = 10 in flight at once, purely to avoid an unrealistic instant pile-up if the count jumps a lot
between polls). When the signal is red and there are more queued vehicles than the current target count,
the excess is trimmed from the **back** of the queue (the vehicle furthest from the stop line is removed
first) until the queue length matches — this keeps the rendered count accurate without visually deleting
the vehicle that's actually at the front, closest to the camera's attention.

## 15. Constants reference

| Constant | Value | Meaning |
|---|---|---|
| `CAR_LENGTH_T` | 24/384 ≈ 0.0625 | Sprite length in t-units |
| `BUMPER_GAP_T` | 10/384 ≈ 0.026 | Target bumper-to-bumper following gap |
| `STOP_LINE_GAP_T` | 8/384 ≈ 0.021 | Target gap between front bumper and the painted stop line |
| `SAFE_GAP_T` | ≈0.0885 | Center-to-center following spacing (= length + bumper gap) |
| `STOP_MARGIN_T` | ≈0.0521 | How far a blocked vehicle's center stops short of the line |
| `EXIT_CLEAR_T` | 0.08 | Required clearance in a shared exit lane before another vehicle may enter |
| `MAX_SPEED_APPROACH` | 0.14 t/s | Speed cap before the stop line |
| `MAX_SPEED_OPEN` | 0.30 t/s | Speed cap inside/past the box |
| `ACCEL` | 0.45 t/s² | Acceleration rate |
| `DECEL` | 0.9 t/s² | Braking rate |
| `LEFT_TURN_BOW` | 12 units | Off-center bow for left-turn curves (opposing lefts separate automatically) |
| `MOVEMENT_PROBS` | 60/25/15% | Straight/left/right movement distribution |
| `BOX_HALF_X` / `BOX_HALF_Y` | 23 / 46 | Half-extent of the (rectangular) junction box on each axis |

## 16. What this logic deliberately does *not* do

Worth stating explicitly, since it's easy to assume otherwise: there is no path-planning, no A*, no
lookahead beyond "the vehicle directly ahead of me" and "is my destination lane currently occupied." There
is no vehicle-to-vehicle negotiation beyond the fixed yield/reservation rules above. Turning direction and
lane choice are decided once, randomly, at spawn — a vehicle never changes its mind mid-journey. This is
intentional: the goal is realistic *emergent* behavior from simple, provably-correct local rules (which is
what makes it tractable to reason about and verify), not a general-purpose traffic simulator.
