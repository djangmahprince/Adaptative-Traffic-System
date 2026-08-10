# AI Traffic Control System — Logic Specification

Reference document for anyone (human or AI) modifying `firmware/traffic_controller/traffic_controller.ino`
— especially GPIO pin reassignment — without breaking the system's intended behavior. Source of truth for
everything below is the actual code in `server/server.py` and `firmware/traffic_controller/traffic_controller.ino`
as of this writing.

## 1. Architecture and roles

Three components, three roles, deliberately separated:

| Component | Role | Responsibility |
|---|---|---|
| Random Forest classifier (`ml/traffic_model.pkl`) | **The Brain** | Predicts a congestion level (Low/Medium/High) per lane from sensor readings. Never decides which direction gets green, never decides timing. |
| `server/server.py`'s phase state machine | **The Officer** | The *only* thing that ever changes which light is green, and for how long. Runs on a background thread purely off elapsed wall-clock time — completely decoupled from how often sensor packets arrive. |
| ESP32 firmware (or the simulator standing in for it) | **The Hands** | Reads sensors, reports readings, executes whatever signal state the Officer decides. Should never make its own timing or priority decisions. |

The physical ESP32 and the Python server communicate over a plain TCP socket (JSON lines, `\n`-terminated),
port 5050. The server never pushes data unprompted — the ESP32 (and the simulator) both poll every 2
seconds: send a sensor packet, receive a signal-instruction packet back. The firmware does **not** run any
local phase-timing logic while connected to the server — it simply displays whatever per-lane color
(`laneX_signal`) the most recent response said, with no interpolation or prediction in between polls (see
§7 for why this simple approach is still safe). It only ever makes its own timing decisions in an explicit,
clearly-logged fallback mode, entered solely when the server link has been down for several seconds
straight — never as a routine part of normal operation.

## 2. Wire protocol

### ESP32 → Server (every ~2s)

```json
{
  "laneA_count": 3, "laneB_count": 1, "laneC_count": 2, "laneD_count": 0,
  "laneA_wait": 12, "laneB_wait": 4, "laneC_wait": 8, "laneD_wait": 0,
  "laneA_activation": 6.5, "laneB_activation": 2.1, "laneC_activation": 4.0, "laneD_activation": 0,
  "emergency": "0",
  "timestamp": 1735000000
}
```
- `laneX_count` — integer vehicle count for lane X (X ∈ A/B/C/D)
- `laneX_wait` — integer/float seconds the lane has been continuously occupied
- `laneX_activation` — float, a rough "how active is this sensor" signal fed to the ML model as a third feature (real firmware derives it from consecutive-detection time; the simulator fakes it from count × a random factor — the exact derivation doesn't matter to the server, only that it's a plausible positive number correlated with congestion)
- `emergency` — `"0"` normally; the RFID tag's UID string (e.g. `"DE:AD:BE:EF"`) when an emergency tag was just read
- `timestamp` — unix seconds, informational only, not used for any timing decision

### Server → ESP32 (response to every packet)

```json
{
  "laneA_green": 23, "laneB_green": 0, "laneC_green": 23, "laneD_green": 0,
  "laneA_signal": "GREEN", "laneB_signal": "RED", "laneC_signal": "GREEN", "laneD_signal": "RED",
  "amber_time": 3,
  "active_phase": 0,
  "phase_state": "EW_GREEN",
  "emergency_active": false,
  "emergency_lane": null
}
```
- **`laneX_green` is SECONDS REMAINING in the current phase right now, not a fixed phase duration.**
  It is recomputed fresh on every single response and counts down toward 0 as the phase progresses. The
  current firmware stores this (as `greenRemaining`) purely for telemetry — it never uses it to drive any
  local timing decision, which is what keeps it safe from the "read remaining as if it were a fixed
  duration" bug described in §7.
- `laneX_signal` — authoritative signal color for that lane: `"RED"` / `"YELLOW"` / `"GREEN"`. The
  firmware drives each lane's LEDs directly off this field, every time a response arrives, with no
  reinterpretation — this is what makes the firmware's own behavior simple and correct by construction
  (see §7).
- `amber_time` — the yellow duration constant (currently 3s). Not currently read by the firmware, since
  it has no amber LED and no local yellow timer in server-linked mode (see §7) — it's included for any
  future firmware that does need it.
- `active_phase` — `0` = EW (Lanes A+C) active, `1` = NS (Lanes B+D) active. This flips through yellow
  and all-red too (it reflects which *pair* the cycle is currently servicing, not just green). Not
  currently read by the firmware (see §7) — `laneX_signal` alone is sufficient for it.
- `phase_state` — the full state name, one of: `EW_GREEN`, `EW_YELLOW`, `EW_ALL_RED`, `NS_GREEN`,
  `NS_YELLOW`, `NS_ALL_RED`, or (during an emergency) `EMG_GREEN`, `EMG_YELLOW`, `EMG_ALL_RED`. The
  firmware logs this for visibility but doesn't need to parse it to decide LED colors.
- `emergency_active` / `emergency_lane` — not currently read by the firmware at all; unnecessary, since
  during an emergency the affected lanes' `laneX_signal` values already correctly reflect it (one lane
  green, the rest red) with no extra logic required. Kept in the protocol for the dashboard's own use and
  for any future firmware that wants the explicit flag.

## 3. Signal timing logic (the Officer)

### 3.1 Phase sequence — fixed, never varies

```
EW_GREEN --(adaptive 15-60s)--> EW_YELLOW --(3s)--> EW_ALL_RED --(1.5s)-->
NS_GREEN --(adaptive 15-60s)--> NS_YELLOW --(3s)--> NS_ALL_RED --(1.5s)-->
(back to EW_GREEN, repeat forever)
```

| Phase | Lanes GREEN | Lanes RED |
|---|---|---|
| `EW_GREEN` / `EW_YELLOW` | A, C | B, D |
| `NS_GREEN` / `NS_YELLOW` | B, D | A, C |
| `EW_ALL_RED`, `NS_ALL_RED` | — | A, B, C, D (all red) |

The sequence index only ever advances forward through this fixed six-state cycle (or through the
emergency sub-sequence, see §4) — it is driven purely by a background thread checking elapsed wall-clock
time against the current phase's duration, once every 0.25s. **It is never advanced by an incoming sensor
packet.** A real device could stop sending packets entirely and the lights would keep cycling correctly
off the last-known congestion data.

### 3.2 Adaptive green duration formula

Applies only to `EW_GREEN` / `NS_GREEN`. Yellow and all-red durations are fixed constants (§3.3).

```
MIN_GREEN = 15   (seconds)
MAX_GREEN = 60   (seconds)

max_level = the higher of the two active lanes' congestion_level (0=Low, 1=Medium, 2=High)
max_count = the higher of the two active lanes' vehicle_count
max_wait  = the higher of the two active lanes' avg_wait_time

base  = 15 if max_level == 0 (Low)
        25 if max_level == 1 (Medium)
        42 if max_level == 2 (High)

bonus = min(18, max_count * 1.0 + max_wait * 0.25)

duration = clamp(base + bonus, MIN_GREEN, MAX_GREEN)   # rounded to the nearest integer
```

The Random Forest model's *only* input to this formula is `max_level` (congestion classification) plus
the raw `vehicle_count`/`avg_wait_time` it was given — it never picks a direction, never picks a duration
directly. If pin/hardware changes affect how vehicle_count or wait_time are derived from sensor readings,
this formula (and therefore how long lights stay green) changes downstream — keep the sensor→count/wait
mapping realistic.

### 3.3 Fixed timing constants

| Constant | Value | Applies to |
|---|---|---|
| `YELLOW_TIME` | 3s | Every yellow phase, including emergency yellow |
| `ALL_RED_TIME` | 1.5s | Every all-red clearance phase, including emergency all-red |
| `MIN_GREEN` | 15s | Floor for adaptive green |
| `MAX_GREEN` | 60s | Ceiling for adaptive green |

## 4. Emergency vehicle handling — deferred to the next safe boundary

**Core rule: an emergency request never causes an instant light change.** It is recorded as *pending* and
only actually granted at the next safe boundary — the transition out of an ALL_RED state. This means:

1. RFID tag read → server records `pending_emergency = {lane, requested_at, source}`. Nothing about the
   live signal state changes yet.
2. The current green phase finishes normally, transitions to yellow normally, transitions to all-red
   normally.
3. **At the moment the all-red phase would otherwise hand off to the next scheduled phase**, the server
   checks for a pending emergency first. If one exists, it grants it instead of the normal next phase:
   - `EMG_GREEN` — the emergency lane gets a fixed **15s** green, all other lanes red.
   - `EMG_YELLOW` — **3s**, emergency lane only.
   - `EMG_ALL_RED` — **1.5s**, all lanes red.
4. After `EMG_ALL_RED`, the normal alternation resumes **exactly where it left off** (the phase index that
   was interrupted is preserved, not reset) — the emergency is a true interrupt, not a cycle restart.
5. RFID-sourced emergency requests are throttled by a **30-second cooldown** (`EMERGENCY_COOLDOWN_SECS`)
   from the last granted emergency, to avoid one tag re-triggering repeatedly. Manually-triggered emergency
   requests (from the dashboard) bypass this cooldown.

**This deferred design lives entirely in `server.py`, and the current firmware correctly respects it** —
not by re-implementing the sequencing logic locally, but by never making its own emergency decision at
all: it only ever displays whatever `laneX_signal` the server most recently sent (see §7). An RFID tag
read is *reported* to the server and nothing else; the actual grant timing is 100% the server's call.

## 5. Sensor logic — ultrasonic distance → estimated standing queue

The firmware samples one lane at a time in round-robin (every `SAMPLE_INTERVAL` = 120ms, so each lane is
actually re-sampled roughly every `4 × 120ms` = 480ms — not all four simultaneously) and estimates a
**standing queue length**, not just an instantaneous count. This matches how the ML model's training data
defines `vehicle_count` — an estimated number of vehicles waiting in the lane (0–2 Low, 3–5 Medium, 6+
High), not a flow-rate or a raw sensor reading.

```
1. Trigger HC-SR04, measure ECHO pulse width (30ms timeout), convert to cm
   (speed of sound: 0.0343 cm/µs, round-trip halved). Discard readings outside 2–400cm as invalid.
2. Keep the last 3 valid readings for this lane and take their MEDIAN (rejects the
   occasional wild single reading an ultrasonic module throws out, without smearing
   it into later samples the way an averaging filter would).
3. present = (median distance <= 20.0cm)   # DETECTION_DISTANCE
4. Track a rolling ~12-second occupancy window (25 samples) of present/absent, used
   for the "activation" feature (see below).
5. On a present→absent→present debounced edge (3 consecutive clear samples arm the
   lane; the next detection after that counts as one arrival event):
     - if the lane's signal is GREEN right now: this is a DEPARTURE — queue--
     - otherwise (RED/YELLOW):                  this is an ARRIVAL   — queue++ (capped at 15)
6. Continuous presence while the light is red also guarantees queue >= 1 even without
   a fresh edge (a vehicle is visibly standing at the line).
7. If the lane reads continuously clear for >2.5s while GREEN, the queue is
   considered fully discharged and reset to 0 — this is what prevents queue from
   drifting upward forever from noise.
8. wait_time = accumulated seconds of continuous presence (resets each reporting window).
9. sensor_activation = occupied-seconds within the rolling window, CAPPED against
   (queue * 0.7) — without the cap, a queue standing directly on the sensor would
   saturate the raw occupied-seconds figure well outside the range the ML model
   was actually trained on (activation ≈ vehicle_count × 0.3–0.9).
```

This is a materially more sophisticated approach than a simple "distance below threshold = 1 vehicle"
counter (which was an earlier, since-superseded draft of this logic) — it integrates arrivals and
departures over time to approximate a real standing queue from a single presence sensor, which is what
the ML model actually expects as input. If pin/hardware changes involve adding or moving sensors, preserve
this general shape (median filter, debounced arrival/departure edges tied to the current signal color,
clear-on-green flush) rather than reverting to a simpler threshold count, since the model's accuracy
depends on `vehicle_count` meaning "queue length," not "instantaneous detections."

## 6. RFID emergency detection logic

**Currently disabled** (`#define ENABLE_RFID 0` in the firmware) — the RC522's required GPIOs (5, 18, 19,
22, 23) collide with LED pins in the pinout the physical build actually uses. See
`hardware/pin_assignment.md` for exactly which pins to move to free them up and enable it. Until then,
physical RFID tag scanning has no effect; the dashboard's own emergency controls (manual override, demo
scenarios) are entirely unaffected by this, since they call the server's `request_emergency()` directly.

When enabled, the logic is intentionally simple and leans on the server for safety-relevant throttling:

- The reader is polled every loop iteration with no firmware-side cooldown — `checkRFID()` sets
  `emergencyFlag = true` on **any** successfully-read tag UID, with no allow-list check against specific
  "emergency vehicle" UIDs. (This is a deliberate simplification for this build; if untrusted RFID cards
  might be near the reader, reintroducing a UID allow-list — comparing `rfid.uid.uidByte` against known
  emergency tag UIDs before setting the flag — would be a reasonable addition when enabling this.)
- `emergencyFlag` is one-shot: it's sent as `"1"` in the very next outgoing packet, then cleared. Repeated
  taps within the same reporting window are naturally coalesced by that; repeated taps across multiple
  windows are what the **server's** 30-second cooldown (`EMERGENCY_COOLDOWN_SECS`, §4 point 5) throttles —
  the firmware does not need its own cooldown timer since the server already enforces one.
- **Emergency is always assumed to be Lane A** (`request_emergency('A', ...)` is hardcoded server-side).
  If a pin/hardware change relocates the RFID reader or adds readers to other lanes, this hardcoding
  needs to change to pass the actual detecting lane through.

## 7. Firmware/server consistency — how the current firmware stays correct without a local FSM

An earlier draft of this firmware ran its own independent phase state machine that only loosely synced
with the server, which risked three real bugs: an emergency override that could snap instantly and
locally instead of waiting for a safe boundary, no all-red clearance gap between opposing directions, and
a green-duration field that could get misread as a fixed duration instead of a countdown. **The firmware
actually built into the hardware sidesteps all three — not by carefully re-implementing the server's
sequencing locally, but by not trying to predict or time phases at all** while the server link is up. This
section explains why that's both simpler and safe, so pin reassignment work doesn't undo it.

### 7.1 No local phase timer in server-linked mode — LEDs just mirror `laneX_signal`

`readReplies()` copies each lane's `laneX_signal` straight into `lanes[i].signal`; `refreshLamps()`, called
every loop iteration, just calls `applySignal(i, lanes[i].signal)` for all four lanes using whatever was
last received — nothing more. There is no local countdown, no local phase-sequence advancement, no
prediction of what should happen next. The firmware is, as far as timing goes, a pure display for
whatever the server most recently said.

### 7.2 Emergency is 100% server-driven, with no separate code path at all

`checkRFID()` only ever sets a one-shot flag that gets reported in the next outgoing packet
(`sendPacket()`) — it never touches an LED, and there is no `if (emergency) { ...override... }` branch
anywhere in the lamp-driving code. Since (7.1) LEDs are driven purely from `laneX_signal`, an emergency
grant is handled with **zero special-case code**: the server puts the emergency lane's `laneX_signal` to
`"GREEN"` and every other lane's to `"RED"`, and the firmware displays that exactly like it would display
any other green/red combination. This also means a dashboard-triggered emergency (manual override or a
demo scenario, no RFID tag involved at all) reaches the physical lights exactly the same way a real tag
read would — there's no distinction in the firmware between the two, because there's no emergency-specific
logic in the firmware to begin with.

### 7.3 All-red and yellow duration bugs don't apply — there's nothing local to mistime

Since there's no local timer of any kind in server-linked mode, there's nothing to mis-derive a duration
for. `greenRemaining` is stored from `laneX_green` purely for the serial telemetry printout — it never
feeds a countdown. The closest thing to a display nuance: if the server transitions from `YELLOW` through
a brief `ALL_RED` to the next `GREEN` entirely within one ~2-second poll gap, the firmware's *next* poll
after that gap would show the new state correctly, but in the meantime it keeps flashing red (left over
from the last-known `YELLOW`) rather than switching to a steady red for that brief window. This is
cosmetic only — flashing and steady red both mean "stop," so there's no unsafe state ever displayed, just
a possible one-poll-interval delay in which exact red variant is shown. Reducing `SEND_INTERVAL` would
shrink that window further if it ever mattered in practice.

### 7.4 Local fallback — the one place the firmware *does* decide on its own

If the server hasn't replied in `LINK_TIMEOUT` (6s), the firmware assumes the link is down, forces all
lanes red, and switches to `runFallback()` — a local six-state FSM (`FB_NS_GREEN → FB_NS_YELLOW →
FB_NS_RED → FB_EW_GREEN → FB_EW_YELLOW → FB_EW_RED → …`) using the same phase pairing as the server
(A+C together, B+D together) and locally-classified congestion (`localClass()`, thresholds on the queue
estimate and wait time) to pick a green duration from three fixed bands (12s/20s/35s). This is the
*correct* place for the firmware to make its own decisions — it's an explicit, clearly-logged degraded
mode entered only when there genuinely is no server to defer to, not a routine part of normal operation.
The instant the link comes back and a reply arrives, `serverLinked` flips back to `true` and control
reverts to (7.1) — pure mirroring, no local decisions.

## 8. Current GPIO pin assignment (ESP32-WROOM-32)

This is what the actual built hardware uses. Full detail (including the RFID-enablement pin reshuffle) is
in `hardware/pin_assignment.md` — this is the condensed version. Two LEDs per lane (red + green only, no
amber — a server `YELLOW` displays as a flashing red).

### Traffic signal LEDs (8 pins)

| Lane | Approach | RED GPIO | GREEN GPIO |
|---|---|---|---|
| A | West | 4 | 5 |
| B | North | 23 | 22 |
| C | East | 18 | 19 |
| D | South | 21 | 13 |

### HC-SR04 ultrasonic sensors (8 pins: 4× TRIG output, 4× ECHO input)

| Lane | TRIG GPIO | ECHO GPIO |
|---|---|---|
| A | 25 | 34 |
| B | 26 | 35 |
| C | 27 | 32 |
| D | 14 | 33 |

All 4 ECHO lines are 5V logic and **must** pass through a voltage divider before reaching the 3.3V-max
ESP32 GPIO, regardless of which specific pin is used.

### RC522 RFID reader — currently disabled

Wired for GPIO 5 (SS), 22 (RST), plus the default VSPI pins (18 SCK, 19 MISO, 23 MOSI) — all five already
used for LEDs above, hence `ENABLE_RFID` is compiled out. See §6 and `hardware/pin_assignment.md` for the
7-pin reshuffle needed to free them up.

### Reserved — do not assign

| GPIO range | Reason |
|---|---|
| 6–11 | Internal SPI flash — using these will brick/crash the ESP32 |
| 0, 2, 15 | Boot-strapping pins — avoided in the current pinout |
| 34, 35, 32, 33 | Input-only where used for ECHO — do not repurpose as outputs |

If reassigning pins further, the constraints that must still hold: outputs avoid 6–11 and (ideally) avoid
strapping pins 0/2/5/12/15; ECHO inputs stay on input-capable pins.
