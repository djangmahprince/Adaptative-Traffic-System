# ESP32-WROOM-32 Pin Assignment Table

Source of truth: `firmware/traffic_controller/traffic_controller.ino` (Sections 2–4), cross-checked
against `Traffic_Project_Guide_Final.docx` Sections 2.3–2.5. All assignments below are already
implemented in firmware — this table documents them for the hardware design, it does not change them.

## Traffic signal LEDs (12 GPIOs, digital output)

| Lane | Approach | Signal | GPIO | Strapping? | Notes |
|---|---|---|---|---|---|
| A | West  | RED   | 14 | No | |
| A | West  | AMBER | 27 | No | |
| A | West  | GREEN | 26 | No | |
| B | North | RED   | 25 | No | |
| B | North | AMBER | 33 | No | |
| B | North | GREEN | 32 | No | |
| C | East  | RED   | 19 | No | |
| C | East  | AMBER | 18 | No | |
| C | East  | GREEN | **23** | No | **Not GPIO 5** — GPIO 5 is a boot-strapping pin (must be HIGH at boot); driving it LOW via an LED can prevent boot. GPIO 23 is the corrected, verified-safe pin. |
| D | South | RED   | 17 | No | |
| D | South | AMBER | 16 | No | |
| D | South | GREEN | 4  | No | |

## HC-SR04 ultrasonic sensors (8 GPIOs: 4 TRIG output, 4 ECHO input)

| Lane | Function | GPIO | Strapping? | Notes |
|---|---|---|---|---|
| A | TRIG | 13 | No | Also drives RC522 RST (shared, time-multiplexed in firmware — see Signal Sharing below) |
| A | ECHO | 34 | No | Input-only pin — cannot drive output, ideal for a sensor input |
| B | TRIG | 15 | **Yes (MTDO)** | Needs defined logic level at boot; see Validation Report for pull-up vs pull-down analysis |
| B | ECHO | 35 | No | Input-only |
| C | TRIG | 2  | **Yes** | See Validation Report — flagged concern |
| C | ECHO | 36 | No | Input-only |
| D | TRIG | 12 | **Yes (MTDI)** | Determines flash voltage at boot — highest-risk strapping pin; see Validation Report |
| D | ECHO | 39 | No | Input-only |

All 4 ECHO lines are 5V logic from the sensor and **must** pass through the 1kΩ/2kΩ voltage
divider before reaching the ESP32 GPIO (3.3V max tolerant). This applies uniformly regardless of
whether the GPIO is input-only.

## RC522 RFID reader (SPI, 5 GPIOs)

| Function | GPIO | Strapping? | Notes |
|---|---|---|---|
| SDA / SS (chip select) | 21 | No | |
| SCK | 22 | No | |
| MOSI | 0  | **Yes** | Must be HIGH at boot for normal boot mode; RC522 is not powered/driving during ESP32 reset, but see Validation Report |
| MISO | 3  | No (but shared with UART0 RX) | Firmware calls `Serial.end()` before RC522 init — correctly handled |
| RST | 13 | No | **Shared with SEN_A TRIG** (see below) |

## Signal sharing: GPIO 13

GPIO 13 is intentionally shared between `SEN_A.TRIG` (HC-SR04 Lane A trigger) and `U2.RST`
(RC522 reset). This works because:
- Both are firmware-controlled digital outputs, never simultaneously required at conflicting logic levels
- The firmware's `pollRFID()` and `readUltrasonic()` routines are called sequentially in the main
  loop, not concurrently, so there is no bus-contention risk
- This is confirmed in firmware comments ("RST — shared with TRIG_A — managed in code")

This is a valid, intentional design decision already implemented — flagged here only for
schematic-net clarity (both physical pins land on the *same* net).

## GPIO reservation — do not use

| GPIO range | Reason | Consequence if used |
|---|---|---|
| 6–11 | Internal SPI flash memory | Bricked/crashing ESP32 |
| 5 | Boot strapping (must be HIGH at boot) | Avoided by design (Lane C Green moved to GPIO 23) |
| 34, 35, 36, 39 | Input-only, no output driver | Already correctly used for ECHO (input-only) — do not repurpose as outputs |

## Full pin utilization summary

24 unique GPIOs in active use (13 is double-counted intentionally, see above):
`0, 2, 3, 4, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39`

No conflicts found — every pin above is used for exactly one function (except the intentional
GPIO 13 share). None fall in the reserved 6–11 range. GPIO 5 is correctly avoided.
