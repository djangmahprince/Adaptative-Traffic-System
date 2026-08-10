# ESP32-WROOM-32 Pin Assignment Table

**Source of truth: `firmware/traffic_controller/traffic_controller.ino`.** This replaces an earlier
version of this table that assigned TRIG lines to GPIO 0, 2, 12, 15 and RFID MOSI/MISO to GPIO 0 and 3 —
those were strapping pins and the USB serial pair, and that table predates the actual working build. The
pinout below is what the built prototype actually uses.

## Traffic signal LEDs (8 GPIOs — RED + GREEN only, no amber)

The physical build uses two LEDs per lane, not three. A server-sent `YELLOW` instruction is displayed as
a **flashing red** (`applySignal()` in firmware) rather than a dedicated amber LED — this is a deliberate,
documented simplification, not a missing feature: flashing red still reads as "stop," which is the safe
interpretation either way.

| Lane | Approach | RED GPIO | GREEN GPIO |
|---|---|---|---|
| A | West | 4 | 5 |
| B | North | 23 | 22 |
| C | East | 18 | 19 |
| D | South | 21 | 13 |

## HC-SR04 ultrasonic sensors (8 GPIOs: 4 TRIG output, 4 ECHO input)

| Lane | TRIG GPIO | ECHO GPIO |
|---|---|---|
| A | 25 | 34 |
| B | 26 | 35 |
| C | 27 | 32 |
| D | 14 | 33 |

All 4 ECHO lines are 5V logic from the sensor and must pass through a voltage divider before reaching the
3.3V-max ESP32 GPIO, same requirement as before regardless of which specific pin is used.

## RC522 RFID reader — currently DISABLED (`ENABLE_RFID 0`)

The reader is wired for GPIO 5 (SS) and 22 (RST), plus the ESP32's default VSPI pins (18 = SCK, 19 = MISO,
23 = MOSI) — but **all five of those GPIOs are already used for lane LEDs** in the pinout above (5 =
Lane A GREEN, 18 = Lane C RED, 19 = Lane C GREEN, 22 = Lane B GREEN, 23 = Lane B RED). RFID is therefore
compiled out (`#define ENABLE_RFID 0` at the top of the firmware) until that conflict is resolved.

**What this means operationally:** physical RFID tag scanning does nothing right now — emergency vehicle
priority triggered by a real tag is not currently functional on this build. This does **not** affect the
dashboard's own emergency controls (the "Trigger Emergency" override button and the "Emergency Mode" demo
scenario both call the server's `request_emergency()` directly, with no dependency on the physical reader)
— those work exactly as documented in `PROJECT_LOGIC_SPEC.md` §4 regardless of RFID hardware status.

To enable RFID, free the five conflicting GPIOs by moving these LED pins first, then flip
`ENABLE_RFID` to `1`:

| Signal | Move from | Move to | Note |
|---|---|---|---|
| Lane C ECHO | 32 | 36 (VP) | Input-only pin, fine for ECHO |
| Lane D ECHO | 33 | 39 (VN) | Input-only pin, fine for ECHO |
| Lane A GREEN | 5 | 16 | |
| Lane B RED | 23 | 17 | |
| Lane B GREEN | 22 | 32 | (now freed by the ECHO move above) |
| Lane C RED | 18 | 33 | (now freed by the ECHO move above) |
| Lane C GREEN | 19 | 2 | Strapping pin — needs the same pull-up caution as any strapping-pin output |

## GPIO reservation — do not use

| GPIO range | Reason |
|---|---|
| 6–11 | Internal SPI flash — using these will brick/crash the ESP32 |
| 0, 2, 15 | Boot-strapping pins — avoided in the current pinout (0/2 only come into play if RFID is enabled per the table above, and 2 specifically needs the same care as any strapping-pin output) |
| 34, 35, 32, 33 (and 36/39 if freed for RFID per above) | Input-only where used for ECHO — do not repurpose as LED/TRIG outputs |

## Full pin utilization summary (current build, RFID disabled)

16 GPIOs in active use: `4, 5, 13, 14, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35`

No conflicts in the current (RFID-disabled) configuration — every pin above is used for exactly one
function. Enabling RFID requires the 7-pin reshuffle in the table above first.
