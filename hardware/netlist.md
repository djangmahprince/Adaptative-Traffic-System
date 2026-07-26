# Netlist — AI Traffic Control System

Reference designators match `BOM.csv`. This is the authoritative connection list; the KiCad
schematic (`traffic_system.kicad_sch`) is a visual representation of exactly these nets.

## Power nets

| Net name | Connected pins |
|---|---|
| `+5V` | U1.5V/VIN, SEN_A.VCC, SEN_B.VCC, SEN_C.VCC, SEN_D.VCC, C6.+ |
| `+3V3` | U1.3V3, U2.3.3V, C5.+, R13.2 (to GPIO15), R14.2 (to GPIO2), R15.2 (to GPIO12) |
| `GND` | U1.GND, U2.GND, SEN_A.GND, SEN_B.GND, SEN_C.GND, SEN_D.GND, D1–D12 (all cathodes), C1.–, C2.–, C3.–, C4.–, C5.–, C6.–, R17.2, R19.2, R21.2, R23.2 |

## Traffic signal LED nets (GPIO → resistor → LED anode; cathode → GND)

| Net name | Connection |
|---|---|
| `LANE_A_RED` | U1.GPIO14 — R1.1 ; R1.2 — D1.anode |
| `LANE_A_AMBER` | U1.GPIO27 — R2.1 ; R2.2 — D2.anode |
| `LANE_A_GREEN` | U1.GPIO26 — R3.1 ; R3.2 — D3.anode |
| `LANE_B_RED` | U1.GPIO25 — R4.1 ; R4.2 — D4.anode |
| `LANE_B_AMBER` | U1.GPIO33 — R5.1 ; R5.2 — D5.anode |
| `LANE_B_GREEN` | U1.GPIO32 — R6.1 ; R6.2 — D6.anode |
| `LANE_C_RED` | U1.GPIO19 — R7.1 ; R7.2 — D7.anode |
| `LANE_C_AMBER` | U1.GPIO18 — R8.1 ; R8.2 — D8.anode |
| `LANE_C_GREEN` | U1.GPIO23 — R9.1 ; R9.2 — D9.anode |
| `LANE_D_RED` | U1.GPIO17 — R10.1 ; R10.2 — D10.anode |
| `LANE_D_AMBER` | U1.GPIO16 — R11.1 ; R11.2 — D11.anode |
| `LANE_D_GREEN` | U1.GPIO4 — R12.1 ; R12.2 — D12.anode |

All 12 LED cathodes tie to `GND` directly (no resistor on the cathode side).

## HC-SR04 sensor nets

Each channel has a raw (5V-side) net and a divided (3.3V-side) net — they are **not** the same
node; the divider junction is the actual point that connects to the ESP32 GPIO.

| Lane | Net name | Connection |
|---|---|---|
| A | `TRIG_A` | U1.GPIO13 — SEN_A.TRIG — U2.RST *(3-way shared net, see pin_assignment.md)* |
| A | `ECHO_A_RAW` | SEN_A.ECHO — R16.1 |
| A | `ECHO_A_DIV` | R16.2 — R17.1 — U1.GPIO34 *(divider midpoint feeds the GPIO)* |
| B | `TRIG_B` | U1.GPIO15 — SEN_B.TRIG — R13.1 *(R13.2 to +3V3, pull-up)* |
| B | `ECHO_B_RAW` | SEN_B.ECHO — R18.1 |
| B | `ECHO_B_DIV` | R18.2 — R19.1 — U1.GPIO35 |
| C | `TRIG_C` | U1.GPIO2 — SEN_C.TRIG — R14.1 *(R14.2 to +3V3, pull-up — FLAGGED, see validation report)* |
| C | `ECHO_C_RAW` | SEN_C.ECHO — R20.1 |
| C | `ECHO_C_DIV` | R20.2 — R21.1 — U1.GPIO36 |
| D | `TRIG_D` | U1.GPIO12 — SEN_D.TRIG — R15.1 *(R15.2 to +3V3, pull-up — FLAGGED, highest risk, see validation report)* |
| D | `ECHO_D_RAW` | SEN_D.ECHO — R22.1 |
| D | `ECHO_D_DIV` | R22.2 — R23.1 — U1.GPIO39 |

`ECHO_x_RAW` to `ECHO_x_DIV` junction is the divider node: R(series)=1k towards the sensor,
R(to GND)=2k. Divided voltage = 5V × 2k/(1k+2k) = 3.33V.

## RC522 SPI nets

| Net name | Connection |
|---|---|
| `RFID_SS` | U1.GPIO21 — U2.SDA |
| `RFID_SCK` | U1.GPIO22 — U2.SCK |
| `RFID_MOSI` | U1.GPIO0 — U2.MOSI |
| `RFID_MISO` | U1.GPIO3 — U2.MISO |
| `RFID_RST` | (see `TRIG_A`, shared net) |

## Decoupling nets

| Net | Connection |
|---|---|
| — | C1 across SEN_A: `+5V`—C1.+, C1.–—`GND` (placed as close to SEN_A.VCC/GND pins as possible) |
| — | C2 across SEN_B, C3 across SEN_C, C4 across SEN_D — same pattern |
| — | C5 across U2 (RC522): `+3V3`—C5.+, C5.–—`GND` |
| — | C6 bulk cap: `+5V`—C6.+, C6.–—`GND`, placed at the breadboard's main 5V power entry point |

## Net count summary

This table lists 31 *logical signal paths* (e.g. "GPIO14 drives Lane A Red") for readability.
Strictly, a resistor's two legs are electrically different nets, so the generated schematic
(`traffic_system.kicad_sch`) has 43 physical nets once each LED's GPIO-side and LED-side of its
series resistor are counted separately (12 LED signal nets + 12 LED-side nets + 3 power nets +
4 TRIG + 8 ECHO raw/divided pairs + 4 RFID = 43). Both counts describe the same design — `43` is
the number KiCad's ERC/netlist export will report; `31` is the number of meaningfully-distinct
signals a human reads this document for. `verify_schematic.py` confirms the schematic has no
dead-end (singly-connected) net, i.e. no floating pins.

- Power nets: 3 (`+5V`, `+3V3`, `GND`)
- LED nets: 12 (24 physical nets once split by their series resistors)
- Sensor nets: 12 (4 TRIG + 8 ECHO raw/divided pairs)
- RFID nets: 4 unique (RST shared with TRIG_A)
- **Total: 31 logical signal paths / 43 physical nets**
