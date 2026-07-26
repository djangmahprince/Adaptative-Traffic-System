# Transfer & Setup Instructions

You're moving `hardware.zip` to the laptop with KiCad installed. Steps below, in order.

## 1. Copy the archive over

Use whatever's easiest — USB drive, cloud storage (Google Drive/OneDrive), or emailing it to
yourself. `hardware.zip` is small (a few hundred KB), so any method works.

## 2. Unzip it

Extract `hardware.zip` to any folder on the KiCad laptop — e.g. `Desktop\traffic_hardware\`.
You should see 11 files: this instructions file, `README.md`, `BOM.csv`, `pin_assignment.md`,
`netlist.md`, `connector_list.md`, `hardware_design_reference.html`, `traffic_system.kicad_sch`,
`traffic_system.kicad_pro`, and the two Python generator/verify scripts.

## 3. Open the project in KiCad

- Launch KiCad
- **File → Open Project…** and select `traffic_system.kicad_pro`
- Double-click the schematic in the project window (or it may open automatically)

**If KiCad shows an error or a blank project on this step:** the `.kicad_pro` file was
hand-generated without access to KiCad to verify its exact format (see `README.md` §5) — this is
the one place that might not import cleanly. Fallback, takes under a minute:
1. **File → New Project…**, create it in the same folder (KiCad will ask to overwrite/keep the
   existing `.kicad_sch` — keep it, only replace the `.kicad_pro`)
2. This generates a guaranteed-valid project file pointing at your existing schematic
3. Everything else (parts, wiring, nets) lives in `traffic_system.kicad_sch`, which is unaffected
   by this — you won't lose anything

## 4. Run Electrical Rules Check (ERC)

In the schematic editor: **Inspect → Electrical Rules Checker → Run**.

What to expect:
- **Unconnected pin warnings on `IRQ`-type or similar unused pins** — none exist in this design
  (only pins actually wired per `netlist.md` were placed), so if you see this, something's off —
  compare against `pin_assignment.md`.
- **"Pin not driven" or similar for input-only nets** — the ESP32's `GPIO34/35/36/39` (ECHO
  inputs) and the RC522's `MISO` are declared as inputs with nothing else marked as a driver in
  this simplified schematic (a real HC-SR04/RC522 symbol would show as an output driving them) —
  this is a known, harmless side effect of using simplified black-box module symbols rather than
  full library parts with correctly typed pins on both ends. Safe to acknowledge/ignore if that's
  the only class of warning you see.
- **Anything else** (actual net name typos, a truly floating pin, a genuine short) — cross-check
  against `netlist.md`, which is the verified source of truth. If they disagree, trust
  `netlist.md` and fix the schematic to match, not the other way round.

## 5. Look it over visually

Zoom in, confirm labels are legible, and spot-check a couple of nets against `netlist.md` — e.g.
click the `TRIG_A` label near the ESP32 symbol and confirm it highlights the same net at
`SEN_A.TRIG` and `U2.RST` (the intentional shared pin).

## 6. Before you wire anything physically

Two open items from the validation report (`README.md` §3.5 and §3.3) — cheap to check now,
expensive to debug after everything's soldered/breadboarded:

- **GPIO 2 / GPIO 12 pull-ups**: wire as specified, but power-cycle the ESP32 several times once
  the HC-SR04 TRIG lines (with their 10kΩ pull-ups) are connected, *before* attaching sensors/RFID
  permanently. If boot ever fails or is inconsistent, swap those two pull-ups for pull-downs.
- **Green LED forward voltage**: measure your actual green LEDs' Vf with a multimeter (diode
  mode) before committing to 220Ω resistors — if they read dim, drop to ~150Ω on green channels
  only.

## 7. Ordering parts

`BOM.csv` opens directly in Excel/Sheets/Numbers — it's the shopping list, with a `Status` column
already marking what you have vs. what to buy, matching the project guide.

## What you do *not* need to do

This is a schematic/wiring reference for the breadboard-and-cardboard prototype, not a PCB
fabrication package (per the confirmed scope) — you don't need to assign footprints, open the PCB
editor, or run Design Rules Check (DRC). Those only matter if you later decide to move this to a
custom fabricated board.
