# Connector List

This is a breadboard-prototype build (per project decision — no custom PCB), so most
"connectors" are the module headers already on each breakout board plus jumper wires, not
board-to-board headers you need to source separately. Listed for completeness and BOM traceability.

| Designator | Type | Pin count | Mates with | Notes |
|---|---|---|---|---|
| U1 (ESP32) power | Micro-USB or USB-C (board-dependent) | — | CBL1 | Confirm which connector your specific dev board uses before buying CBL1 |
| U1 GPIO headers | 2× 0.1" pin header (male, on-board) | 19+19 (typical 38-pin DEVKIT) | Jumper wires (W1) | Already populated on most dev boards |
| SEN_A–D (HC-SR04) | 0.1" pin header (male, on-board) | 4 (VCC, TRIG, ECHO, GND) | Jumper wires (W1) | Standard across all 4 units |
| U2 (RC522) | 0.1" pin header (male, on-board) | 8 (3.3V, RST, GND, MISO, MOSI, SCK, SDA, IRQ*) | Jumper wires (W1) | *IRQ unused — leave unconnected |
| BB1, BB2 | 830-point solderless breadboard | — | Jumper wires, module headers | BB1 hosts U1 + Lane A/B; BB2 hosts Lane C/D |
| Power entry | Breadboard power rail | — | CBL1 (via U1's 5V/GND pins) | Jumper from U1.5V/GND to each breadboard's rail |

## Wires required (by function, not literal connector part numbers)

| From | To | Wire count | Notes |
|---|---|---|---|
| U1 GND | BB1 rail, BB2 rail | 2 | One ground jumper per breadboard, per guide Section 3.2 |
| U1 5V/VIN | BB1 rail (+5V) | 1 | Feeds SEN_A, SEN_B directly; bridge to BB2 for SEN_C, SEN_D |
| U1 3V3 | U2 (RC522) 3.3V | 1 | Do not connect RC522 to 5V |
| U1 GPIOs → LEDs | 12 signal wires + 12 resistor legs | 12 | Via 220Ω resistors, see netlist.md |
| U1 GPIOs → HC-SR04 | 4 TRIG + 4 ECHO (via divider) | 8 | Divider resistors sit inline on ECHO wires |
| U1 GPIOs → RC522 | 4 SPI signal wires (SS/SCK/MOSI/MISO) + shared RST | 4 | RST reuses the TRIG_A wire, no separate run |

No connector housings, crimped headers, or custom cables need to be purchased beyond the
jumper wire set (W1) already in the original BOM — this is intentional given the "breadboard
prototype, not fabricated PCB" scope decision. If you later move to a PCB, this list would
expand to JST/terminal-block connectors for each module and is not covered here.
