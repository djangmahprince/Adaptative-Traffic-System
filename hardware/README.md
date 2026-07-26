# Hardware Design — AI Traffic Control System

Scope confirmed with project owner: **schematic + wiring documentation for the breadboard/
cardboard-model prototype** (not a fabricated PCB), powered via **USB from a laptop or USB power
bank** (not a standalone battery rig). This document is the master reference; see also:

- `pin_assignment.md` — full GPIO table
- `netlist.md` — net-by-net connection list
- `BOM.csv` — bill of materials
- `connector_list.md` — connectors/headers/wiring
- `traffic_system.kicad_pro` / `traffic_system.kicad_sch` — KiCad schematic (see caveat below)

All GPIO assignments and wiring rules are taken directly from `Traffic_Project_Guide_Final.docx`
and the already-written `firmware/traffic_controller/traffic_controller.ino` — this design does
not reinterpret or change them, only documents, validates, and adds the supporting circuitry
(decoupling, power distribution) that neither source specified.

---

## 1. Architecture overview

```
                         ┌─────────────────────────────┐
   USB 5V (laptop/       │        ESP32-WROOM-32       │
   power bank)  ─────────┤  Onboard AMS1117 3.3V LDO   │
                         │  240MHz dual-core, WiFi      │
                         └───┬──────┬──────┬───────────┘
                             │      │      │
              ┌──────────────┘      │      └──────────────┐
              │                     │                      │
      12× GPIO (digital out)  8× GPIO (4 TRIG out,   5× GPIO (SPI: SS,
      220Ω → LED → GND        4 ECHO in via divider) SCK, MOSI, MISO, RST)
              │                     │                      │
      ┌───────▼───────┐    ┌────────▼────────┐    ┌────────▼────────┐
      │ 12× LEDs       │    │ 4× HC-SR04      │    │ RC522 RFID      │
      │ (R/A/G × 4     │    │ ultrasonic      │    │ reader          │
      │  lanes)        │    │ sensors         │    │ (Lane A)        │
      └────────────────┘    └─────────────────┘    └─────────────────┘

  ESP32 WiFi ⇄ mobile hotspot ⇄ TCP socket (port 5050) ⇄ Python server (ml + phase logic)
```

## 2. Design decisions and rationale

### 2.1 Power architecture
The ESP32 dev board is powered entirely over USB (confirmed scope). Its onboard 5V→3.3V LDO
regulator supplies the chip; the board's 5V/VIN pin is the same USB 5V rail passed through and is
used to power the four HC-SR04 sensors (they require 5V, not 3.3V). The board's 3.3V output pin
powers the RC522 reader. **No external regulator is required** because everything runs from the
already-regulated board rails — this is the direct consequence of choosing USB power over a
standalone battery rig.

### 2.2 Why LEDs are driven from GPIO directly, not a rail
Each LED's current path is GPIO → 220Ω resistor → LED → GND, sourcing current directly from the
pin driver, not from the 3.3V/5V rail through a separate switch. This matches the existing
firmware (`digitalWrite` per pin) and keeps the design simple since LED current (≈5.9mA each) is
well within a single GPIO's safe sourcing current — no transistor/driver stage needed.

### 2.3 Why HC-SR04 ECHO needs a divider and TRIG doesn't
TRIG is an *input* to the sensor — the ESP32 only needs to assert a 3.3V logic pulse, which the
sensor reads fine. ECHO is an *output* from the sensor at 5V logic, which exceeds the ESP32
GPIO absolute maximum (3.6V) — connecting it directly risks permanent pin damage. The
1kΩ series + 2kΩ-to-GND divider steps 5V down to 3.33V, which is within tolerance. This is
already correctly specified in the project guide; documented here for schematic completeness.

### 2.4 Why RC522 must be 3.3V only
MFRC522 is a 3.3V-only part with no onboard 5V tolerance — unlike HC-SR04, there is no safe way
to run it from 5V, so it draws from the ESP32's regulated 3.3V pin, not the shared 5V rail.

### 2.5 Additions beyond the original guide (flagged for your awareness)
The guide's Section 3 does not mention decoupling capacitors or a USB cable in its BOM. Both are
added here:

- **C1–C5 (100nF ceramic, one per HC-SR04 and one for the RC522):** placed directly across each
  module's VCC/GND pins. Ultrasonic sensors switch a transducer at kHz rates and can inject noise
  back onto the shared 5V rail; a small ceramic cap right at the module suppresses this and
  reduces false-trigger risk on ECHO readings.
- **C6 (220µF electrolytic, on the main 5V rail near the ESP32's VIN pin):** four HC-SR04 modules
  triggering in the same polling window, combined with WiFi TX current bursts (up to ~300mA
  peaks), can create a transient current demand that a thin USB cable or breadboard rail may not
  supply instantaneously — this can show up as a brownout reset. A bulk capacitor buffers that.
- **CBL1 (USB cable) and PWR1 (power source):** the original guide never listed how the board is
  powered; since USB was confirmed, these are now explicit BOM items with a minimum 1A rating
  called out — a USB port/cable rated for less can brownout under the combined LED + WiFi + sensor
  load described above.

These are recommended additions, not requirements — the system will likely work without them on
a good, short USB cable. They're cheap insurance against the flakiest class of embedded bugs
(intermittent resets/false sensor reads under load).

---

## 3. Validation report

### 3.1 GPIO conflict check — PASS
All 24 GPIOs in use (see `pin_assignment.md`) are distinct except the intentional GPIO 13 share
between `SEN_A.TRIG` and `U2.RST` (sequential access in firmware, not concurrent — no contention).
None fall in the reserved GPIO 6–11 range (internal SPI flash). GPIO 5 is correctly avoided
(Lane C Green uses GPIO 23 instead).

### 3.2 Voltage level check — PASS
- ESP32 logic: 3.3V throughout (GPIO absolute max 3.6V per Espressif datasheet)
- RC522: 3.3V supply and 3.3V SPI logic — direct connection to ESP32 is correct, no level shifting needed
- HC-SR04: 5V supply; TRIG accepts 3.3V input directly (safe, sensor's input threshold accepts
  it); ECHO output at 5V is stepped down to 3.33V via divider before reaching any GPIO — **verified
  within tolerance** (3.33V < 3.6V absolute max, with reasonable margin)

### 3.3 Current budget check — PASS
- Per-LED current: I = (3.3V − Vf) / 220Ω. At Vf≈2.0V (typical red/amber): ≈5.9mA. This is well
  under the ESP32's recommended 12mA/pin sourcing limit.
- **Flag:** green LEDs commonly have a higher forward voltage (2.8–3.2V for many standard 5mm
  parts) than red/amber (~2.0V). At Vf=3.0V with the same 220Ω resistor, current drops to
  ≈1.4mA — not unsafe, but the green LEDs may appear noticeably dimmer than red/amber.
  **Recommend:** measure actual Vf of your specific green LEDs with a multimeter (diode mode) or
  datasheet before final assembly; if dim, reducing R3/R6/R9/R12 to ~150Ω (green only) restores
  brightness parity while staying under the 12mA limit (I≈(3.3−3.0)/150Ω≈2mA — still very
  conservative; can go lower, e.g. 100Ω, if still dim: I≈3mA).
- Aggregate LED current (worst case, all 12 lit simultaneously during the LED test's Phase 3):
  ≈12×5.9mA ≈ 71mA total across all GPIOs — trivial compared to the ESP32's total pin-current
  budget and the onboard regulator's typical 500mA–1A rating.
- HC-SR04 ×4 active current: ~15mA each ≈ 60mA total from the 5V rail — trivial.
- RC522 active current: ~13–26mA from the 3.3V rail — trivial.
- Combined worst case (WiFi TX burst ~250–300mA + LEDs ~71mA + RC522 ~26mA) ≈ 350–400mA peak —
  should be comfortably inside most ESP32 dev boards' onboard regulator capacity, **provided the
  USB source itself can supply ≥500mA–1A** (see recommendation in §2.5 re: cable/port rating).

### 3.4 HC-SR04 divider check — PASS
Divider output = 5V × 2kΩ/(1kΩ+2kΩ) = 3.33V. Current drawn from the sensor's ECHO output through
the divider = 5V/3kΩ ≈ 1.67mA — negligible load, well within a digital output's drive capability.

### 3.5 Strapping-pin risk — ⚠ FLAGGED FOR YOUR CONFIRMATION
The guide specifies 10kΩ pull-ups to 3.3V on GPIO 15, 2, and 12 (used as TRIG_B/C/D). This is
**not uniformly the safest choice** and is the one place this review recommends a change:

| GPIO | Boot requirement (Espressif reference) | Guide's pull-up | Risk if pulled HIGH externally |
|---|---|---|---|
| 15 (MTDO) | Low = boot log silent; otherwise non-critical | Pull-up (3.3V) | **Low risk** — this pin is the most forgiving of the three; a pull-up is generally safe |
| 2 | Must be LOW or floating for normal SPI boot mode | Pull-up (3.3V) | **Moderate risk** — an external pull-up can compete with the boot ROM's expectation during the reset window and reduce boot reliability, especially combined with certain flash modes |
| 12 (MTDI) | Must be LOW at boot to select 3.3V flash voltage (the near-universal default) | Pull-up (3.3V) | **Highest risk** — pulling this HIGH at boot can select 1.8V flash voltage instead of 3.3V, which can prevent the board from booting at all on modules with 3.3V flash (i.e. nearly all ESP32-WROOM-32 boards) |

This is a known ESP32 hardware gotcha, not a certainty of failure — many hobbyist projects do use
external pull-ups on GPIO2 without issue, and the actual outcome depends on your specific board's
onboard strapping resistors (some boards already have their own pull configuration that
dominates). **Recommendation, in order of preference:**
1. Wire everything as specified, but **power-cycle test the board with the pull-up resistors
   connected before final assembly** — if it boots reliably every time, you're fine.
2. If boot becomes unreliable once GPIO12/2's pull-ups are attached, try a **10kΩ pull-down**
   instead of pull-up on those two specifically (GPIO15 can safely stay pull-up) — a pull-down
   more closely matches their documented "LOW at boot" requirement while still giving the TRIG
   line a defined idle state before `setup()` configures it as an output.
3. Either way, this is a two-resistor change at most and does not affect any other part of the
   design — flagging it now so it doesn't cost you a debugging session later.

### 3.6 GPIO0/GPIO3 (RFID) — PASS with existing mitigation
GPIO0 (MOSI) must be HIGH at boot; the RC522 is a passive SPI slave and does not drive this line
during ESP32 reset, so no additional mitigation is needed. GPIO3 (MISO) doubles as UART0 RX —
firmware already calls `Serial.end()` before RC522 initialization, which is the correct fix, and
is documented for cross-reference.

### 3.7 Signal integrity — no PCB, so no trace concerns
Since this stays a breadboard prototype, there is no controlled-impedance, ground-plane, or trace
length analysis to perform. The main practical integrity concern for a breadboard build is loose
jumper connections on the ECHO divider (a floating divider midpoint would read garbage) — verify
with a multimeter that R16/R18/R20/R22 series resistors make solid contact before trusting sensor
readings.

---

## 4. Assumptions requiring your confirmation

1. **ESP32 board variant** — the exact onboard regulator current rating and USB connector type
   (Micro-USB vs USB-C) depend on which specific ESP32-WROOM-32 dev board you have (e.g. DOIT
   DEVKIT V1 vs others). Confirm before buying `CBL1`.
2. **LED forward voltage** — assumed 2.0V generically per the guide's original calculation;
   green LEDs are flagged as likely higher (§3.3). Confirm with your actual parts.
3. **GPIO 2/12 pull-up vs pull-down** — flagged in §3.5 as the one place this review recommends
   testing before finalizing, rather than a certain failure. Please confirm you're comfortable
   with the "wire as-is, test, adjust if needed" approach, or let me know if you'd rather I
   redesign around pull-downs now.
4. **USB power budget** — confirm your USB power bank/laptop port can sustain ≥500mA continuous;
   most modern ones can, but older/weaker ports (some hubs, some older laptops' rear ports) may not.

---

## 5. KiCad files — how they were built and verified, capability limitation

`traffic_system.kicad_sch` is generated by `generate_kicad_schematic.py`, not hand-typed —
every symbol, pin, wire, and net label is built from Python data structures with a generic
S-expression serializer, which by construction cannot produce unbalanced parentheses. All symbols
(the ESP32 module, HC-SR04, RC522, and the passive parts) are self-authored rather than copied
from KiCad's bundled libraries, so there's no risk of mismatching an external library's pin
numbering against this project's actual GPIO map — every pin position used is defined in this
same file and used consistently. The tradeoff: parts will look like plain labeled boxes rather
than KiCad's polished stock symbol graphics. That's cosmetic only.

`verify_schematic.py` then checks the generated file automatically:
- Every electrical part in `BOM.csv` appears on the schematic exactly once (no missing/duplicate parts)
- No net has only a single connection point (which would mean a floating/unconnected pin)
- Parentheses are balanced (checked at generation time too)

Both scripts ran clean — 47/47 parts placed, 43 nets, zero dead-ends, zero missing parts.

**What this does *not* verify:** I don't have KiCad installed in this environment, so I could not
actually open the file, run KiCad's own Electrical Rules Check, or visually confirm it renders
correctly. The checks above catch the most common hand-authoring mistakes (typos in net names,
forgotten connections, structural corruption) but are not a substitute for KiCad's own ERC.
**Please open the file in KiCad and run Inspect → Electrical Rules Checker before relying on it
for anything beyond a starting point.** If it fails to open cleanly, `pin_assignment.md` and
`netlist.md` are the fully-verified fallback — recreating the schematic by hand from those tables
should take well under an hour.

To regenerate after any change to the netlist tables, edit the `esp32_nets`/pin lists at the top
of `generate_kicad_schematic.py` and re-run both scripts:
```
python generate_kicad_schematic.py && python verify_schematic.py
```
