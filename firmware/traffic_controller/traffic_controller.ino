// ============================================================
//  AI Traffic Control System
//  File: firmware/traffic_controller/traffic_controller.ino
//  Board: ESP32-WROOM-32
//
//  Modules:
//    - HC-SR04 ultrasonic sensors (4 lanes)
//    - RC522 RFID reader (emergency detection)
//    - LED traffic signals (4 lanes × 3 LEDs)
//    - Wi-Fi + TCP client (mobile hotspot)
//    - JSON packet formatting & parsing
//
//  Flow (every 2 seconds):
//    1. Poll all 4 HC-SR04 sensors
//    2. Check RC522 for RFID tag
//    3. Build JSON packet
//    4. Send to Python server via TCP
//    5. Receive timing instructions
//    6. Update LED signals per lane
// ============================================================

#include <WiFi.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>

// ============================================================
//  SECTION 1 — CONFIGURATION
//  Edit WIFI_SSID, WIFI_PASS, SERVER_IP before uploading
// ============================================================

// ── Wi-Fi (use your mobile hotspot credentials) ────────────
const char* WIFI_SSID = "YOUR_HOTSPOT_NAME";
const char* WIFI_PASS = "YOUR_HOTSPOT_PASSWORD";

// ── Python server (run ipconfig on Windows to find hotspot IP)
const char* SERVER_IP   = "192.168.x.x";  // Replace with your laptop's IP
const int   SERVER_PORT = 5050;

// ── Polling interval (must match server expectation) ────────
const unsigned long POLL_INTERVAL_MS = 2000;

// ============================================================
//  SECTION 2 — LED GPIO PIN DEFINITIONS (Audited & Verified)
//  All pins confirmed safe for output on ESP32-WROOM-32
//  GPIO 5 avoided (strapping pin)
// ============================================================

// Lane A — Left (West) approach
#define LANE_A_RED    14
#define LANE_A_AMBER  27
#define LANE_A_GREEN  26

// Lane B — Top (North) approach
#define LANE_B_RED    25
#define LANE_B_AMBER  33
#define LANE_B_GREEN  32

// Lane C — Right (East) approach
#define LANE_C_RED    19
#define LANE_C_AMBER  18
#define LANE_C_GREEN  23   // NOTE: GPIO 23, NOT GPIO 5 (strapping pin)

// Lane D — Bottom (South) approach
#define LANE_D_RED    17
#define LANE_D_AMBER  16
#define LANE_D_GREEN   4

// ============================================================
//  SECTION 3 — HC-SR04 SENSOR PIN DEFINITIONS
//  TRIG: 3.3V output — safe to connect directly
//  ECHO: 5V output  — MUST go through 1KΩ + 2KΩ voltage divider
//  Strapping pin TRIGs (GPIO 15, 2, 12) need 10KΩ pull-up to 3.3V
// ============================================================

#define TRIG_A  13    // Safe output pin
#define ECHO_A  34    // Input-only — ideal for ECHO

#define TRIG_B  15    // Strapping pin — 10KΩ pull-up to 3.3V required
#define ECHO_B  35    // Input-only — ideal for ECHO

#define TRIG_C   2    // Strapping pin — 10KΩ pull-up to 3.3V required
#define ECHO_C  36    // Input-only — ideal for ECHO

#define TRIG_D  12    // Strapping pin — 10KΩ pull-up to 3.3V required
#define ECHO_D  39    // Input-only — ideal for ECHO

// ── Sensor config ────────────────────────────────────────────
const float  SOUND_SPEED_CM_US = 0.0343;  // cm per microsecond
const float  VEHICLE_THRESHOLD_CM = 30.0; // Distance below = vehicle present
const int    SENSOR_READINGS    = 5;       // Readings per poll (averaged)
const unsigned long SENSOR_TIMEOUT_US = 25000; // 25ms timeout (~4m max)

// ============================================================
//  SECTION 4 — RC522 RFID PIN DEFINITIONS
//  RC522 VCC = 3.3V ONLY (not 5V)
//  GPIO 3 (MISO) is also UART RX0 — Serial.end() called in setup
// ============================================================

#define RFID_SS_PIN   21   // SDA / Chip Select
#define RFID_SCK_PIN  22   // SCK
#define RFID_MOSI_PIN  0   // MOSI (strapping pin — handle carefully)
#define RFID_MISO_PIN  3   // MISO (also UART RX0)
#define RFID_RST_PIN  13   // RST  (shared with TRIG_A — managed in code)

// ── Emergency vehicle RFID tag UIDs ──────────────────────────
// Add the UID bytes of your actual MIFARE tags here
// Read them using the DumpInfo example in MFRC522 library
const byte EMERGENCY_TAG_1[] = {0xDE, 0xAD, 0xBE, 0xEF};
const byte EMERGENCY_TAG_2[] = {0x01, 0x02, 0x03, 0x04};
const int  TAG_SIZE = 4;

// ============================================================
//  SECTION 5 — GLOBAL STATE
// ============================================================

WiFiClient   tcpClient;
MFRC522      rfid(RFID_SS_PIN, RFID_RST_PIN);

// Per-lane sensor state
struct LaneState {
  float   lastDistance;
  int     vehicleCount;
  float   waitTime;
  float   sensorActivation;
  int     consecutiveDetections;
  float   distanceHistory[SENSOR_READINGS];
  int     historyIndex;
};

LaneState lanes[4];  // Index: 0=A, 1=B, 2=C, 3=D

// LED pins grouped per lane [RED, AMBER, GREEN]
const int LED_PINS[4][3] = {
  {LANE_A_RED, LANE_A_AMBER, LANE_A_GREEN},
  {LANE_B_RED, LANE_B_AMBER, LANE_B_GREEN},
  {LANE_C_RED, LANE_C_AMBER, LANE_C_GREEN},
  {LANE_D_RED, LANE_D_AMBER, LANE_D_GREEN},
};

// Sensor pins grouped per lane [TRIG, ECHO]
const int SENSOR_PINS[4][2] = {
  {TRIG_A, ECHO_A},
  {TRIG_B, ECHO_B},
  {TRIG_C, ECHO_C},
  {TRIG_D, ECHO_D},
};

// Current signal state per lane: 0=RED, 1=AMBER, 2=GREEN
int  signalState[4]    = {0, 0, 0, 0};
int  greenTimeSec[4]   = {10, 10, 10, 10};  // Default Low congestion

// ── Two-phase signal logic ────────────────────────────────────
// Phase 0: Lanes A(0)+C(2) GREEN simultaneously — horizontal road
// Phase 1: Lanes B(1)+D(3) GREEN simultaneously — vertical road
// This matches real intersection operation: opposing lanes move
// together; perpendicular roads are always stopped.
int  currentPhase      = 0;    // 0 = A+C active, 1 = B+D active
const int PHASE_LANES[2][2] = {{0, 2}, {1, 3}};  // Lane indices per phase

// Emergency flag
bool     emergencyActive = false;
String   emergencyTagUID = "";
unsigned long emergencyStartMs = 0;
const unsigned long EMERGENCY_HOLD_MS = 15000;   // 15 seconds
const unsigned long EMERGENCY_COOLDOWN_MS = 30000; // 30 seconds
unsigned long lastEmergencyMs = 0;

// Timing
unsigned long lastPollMs    = 0;
unsigned long lastCycleMs   = 0;
int           activeLane    = 0;     // Lane currently showing GREEN
bool          inAmberPhase  = false;
unsigned long phaseStartMs  = 0;
const int     AMBER_SEC     = 3;

// ============================================================
//  SECTION 6 — UTILITY FUNCTIONS
// ============================================================

// ── Set all LEDs for one lane ─────────────────────────────────
// signal: 0=RED, 1=AMBER, 2=GREEN
void setSignal(int laneIdx, int signal) {
  signalState[laneIdx] = signal;
  digitalWrite(LED_PINS[laneIdx][0], signal == 0 ? HIGH : LOW);  // RED
  digitalWrite(LED_PINS[laneIdx][1], signal == 1 ? HIGH : LOW);  // AMBER
  digitalWrite(LED_PINS[laneIdx][2], signal == 2 ? HIGH : LOW);  // GREEN
}

// ── All lanes to RED ─────────────────────────────────────────
void allRed() {
  for (int i = 0; i < 4; i++) setSignal(i, 0);
}

// ── Moving average filter for sensor readings ─────────────────
float movingAverage(LaneState &ls, float newReading) {
  ls.distanceHistory[ls.historyIndex] = newReading;
  ls.historyIndex = (ls.historyIndex + 1) % SENSOR_READINGS;
  float sum = 0;
  for (int i = 0; i < SENSOR_READINGS; i++) sum += ls.distanceHistory[i];
  return sum / SENSOR_READINGS;
}

// ── Read one HC-SR04 sensor ───────────────────────────────────
// Returns distance in cm, or -1.0 on timeout
float readUltrasonic(int trigPin, int echoPin) {
  // Release TRIG_A / RST_PIN conflict momentarily
  // RFID RST is held HIGH in idle so we can safely pulse TRIG
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duration = pulseIn(echoPin, HIGH, SENSOR_TIMEOUT_US);
  if (duration == 0) return -1.0;  // Timeout
  return (duration * SOUND_SPEED_CM_US) / 2.0;
}

// ── Check if byte array matches an emergency tag ─────────────
bool isEmergencyTag(byte *uid, byte uidSize) {
  if (uidSize != TAG_SIZE) return false;
  bool match1 = true, match2 = true;
  for (int i = 0; i < TAG_SIZE; i++) {
    if (uid[i] != EMERGENCY_TAG_1[i]) match1 = false;
    if (uid[i] != EMERGENCY_TAG_2[i]) match2 = false;
  }
  return match1 || match2;
}

// ── Format UID bytes as hex string ───────────────────────────
String uidToString(byte *uid, byte uidSize) {
  String result = "";
  for (byte i = 0; i < uidSize; i++) {
    if (uid[i] < 0x10) result += "0";
    result += String(uid[i], HEX);
    if (i < uidSize - 1) result += ":";
  }
  result.toUpperCase();
  return result;
}

// ============================================================
//  SECTION 7 — Wi-Fi CONNECTION
// ============================================================

void connectWiFi() {
  Serial.println("\nConnecting to hotspot: " + String(WIFI_SSID));
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi connected!");
    Serial.println("ESP32 IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nWi-Fi FAILED. Check SSID/password. Restarting...");
    delay(3000);
    ESP.restart();
  }
}

// ============================================================
//  SECTION 8 — TCP CONNECTION
// ============================================================

void connectTCP() {
  Serial.println("Connecting to server " + String(SERVER_IP) + ":" + String(SERVER_PORT));
  int attempts = 0;
  while (!tcpClient.connected() && attempts < 10) {
    if (tcpClient.connect(SERVER_IP, SERVER_PORT)) {
      Serial.println("TCP connected to Python server.");
      return;
    }
    Serial.print(".");
    delay(1000);
    attempts++;
  }
  if (!tcpClient.connected()) {
    Serial.println("TCP connection FAILED. Will retry next poll.");
  }
}

// ============================================================
//  SECTION 9 — SENSOR POLLING
// ============================================================

void pollSensors() {
  for (int i = 0; i < 4; i++) {
    LaneState &ls = lanes[i];
    int trigPin = SENSOR_PINS[i][0];
    int echoPin = SENSOR_PINS[i][1];

    float dist = readUltrasonic(trigPin, echoPin);
    if (dist < 0) dist = 400.0;  // Timeout = no vehicle

    float avgDist = movingAverage(ls, dist);
    ls.lastDistance = avgDist;

    bool vehiclePresent = (avgDist < VEHICLE_THRESHOLD_CM);

    if (vehiclePresent) {
      ls.consecutiveDetections++;
      ls.sensorActivation += (POLL_INTERVAL_MS / 1000.0);
      ls.vehicleCount = min(ls.consecutiveDetections, 12);
      ls.waitTime     = ls.consecutiveDetections * (POLL_INTERVAL_MS / 1000.0);
    } else {
      // Reset when lane clears
      ls.consecutiveDetections = 0;
      ls.vehicleCount          = 0;
      ls.waitTime              = 0;
      ls.sensorActivation      = 0;
    }
  }
}

// ============================================================
//  SECTION 10 — RFID POLLING
// ============================================================

void pollRFID() {
  // Skip if RFID not present or in cooldown
  unsigned long now = millis();
  if (now - lastEmergencyMs < EMERGENCY_COOLDOWN_MS && lastEmergencyMs > 0) return;

  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial())   return;

  String uid    = uidToString(rfid.uid.uidByte, rfid.uid.size);
  bool   isEmg  = isEmergencyTag(rfid.uid.uidByte, rfid.uid.size);

  Serial.println("RFID tag detected: " + uid + (isEmg ? " [EMERGENCY]" : ""));

  if (isEmg) {
    emergencyActive   = true;
    emergencyTagUID   = uid;
    emergencyStartMs  = now;
    lastEmergencyMs   = now;
    Serial.println("EMERGENCY VEHICLE DETECTED — activating override.");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// ============================================================
//  SECTION 11 — BUILD & SEND JSON PACKET
// ============================================================

bool sendPacket() {
  if (!tcpClient.connected()) {
    connectTCP();
    if (!tcpClient.connected()) return false;
  }

  // Check if emergency hold has expired
  if (emergencyActive && (millis() - emergencyStartMs >= EMERGENCY_HOLD_MS)) {
    emergencyActive = false;
    emergencyTagUID = "";
    Serial.println("Emergency override expired. Resuming normal operation.");
  }

  // Build JSON
  StaticJsonDocument<512> doc;
  doc["laneA_count"]      = lanes[0].vehicleCount;
  doc["laneB_count"]      = lanes[1].vehicleCount;
  doc["laneC_count"]      = lanes[2].vehicleCount;
  doc["laneD_count"]      = lanes[3].vehicleCount;
  doc["laneA_wait"]       = (int)lanes[0].waitTime;
  doc["laneB_wait"]       = (int)lanes[1].waitTime;
  doc["laneC_wait"]       = (int)lanes[2].waitTime;
  doc["laneD_wait"]       = (int)lanes[3].waitTime;
  doc["laneA_activation"] = lanes[0].sensorActivation;
  doc["laneB_activation"] = lanes[1].sensorActivation;
  doc["laneC_activation"] = lanes[2].sensorActivation;
  doc["laneD_activation"] = lanes[3].sensorActivation;
  doc["emergency"]        = emergencyActive ? emergencyTagUID : String("0");
  doc["timestamp"]        = (unsigned long)(millis() / 1000);

  // Serialize and send (newline-terminated)
  String payload;
  serializeJson(doc, payload);
  payload += "\n";

  size_t written = tcpClient.print(payload);
  if (written == 0) {
    Serial.println("Send failed — TCP disconnected.");
    tcpClient.stop();
    return false;
  }

  Serial.print("Sent: A=" + String(lanes[0].vehicleCount) +
               "v B=" + String(lanes[1].vehicleCount) +
               "v C=" + String(lanes[2].vehicleCount) +
               "v D=" + String(lanes[3].vehicleCount) +
               "v Emg=" + (emergencyActive ? emergencyTagUID : "0"));
  return true;
}

// ============================================================
//  SECTION 12 — RECEIVE & PARSE SERVER RESPONSE
// ============================================================

bool receiveResponse() {
  unsigned long startMs = millis();
  String responseStr = "";

  // Wait up to 3 seconds for response
  while (millis() - startMs < 3000) {
    if (tcpClient.available()) {
      char c = tcpClient.read();
      if (c == '\n') break;
      responseStr += c;
    }
    delay(1);
  }

  if (responseStr.length() == 0) {
    Serial.println("No response from server.");
    return false;
  }

  StaticJsonDocument<256> resp;
  DeserializationError err = deserializeJson(resp, responseStr);
  if (err) {
    Serial.println("JSON parse error: " + String(err.c_str()));
    return false;
  }

  // Update green times — both lanes in a phase get the same value
  greenTimeSec[0] = resp["laneA_green"] | 10;
  greenTimeSec[1] = resp["laneB_green"] | 10;
  greenTimeSec[2] = resp["laneC_green"] | 10;
  greenTimeSec[3] = resp["laneD_green"] | 10;
  bool emgActive  = resp["emergency_active"] | false;

  // Sync phase from server to keep ESP32 and server aligned
  int serverPhase = resp["active_phase"] | 0;
  currentPhase = serverPhase;

  Serial.println(" → Phase:" + String(currentPhase) +
                 " A:" + String(greenTimeSec[0]) +
                 "s B:" + String(greenTimeSec[1]) +
                 "s C:" + String(greenTimeSec[2]) +
                 "s D:" + String(greenTimeSec[3]) + "s" +
                 (emgActive ? " [EMERGENCY]" : ""));
  return true;
}

// ============================================================
//  SECTION 13 — ADAPTIVE SIGNAL CYCLE (REALISTIC TWO-PHASE)
//
//  Phase 0: Lanes A + C (horizontal road) GREEN together
//  Phase 1: Lanes B + D (vertical road)   GREEN together
//
//  Green duration = server-assigned time for the active phase
//  (server picks the MAX congestion of the two active lanes).
//  Amber = 3 seconds between every phase switch.
//
//  Emergency override: all RED except emergency lane → GREEN.
// ============================================================

void runSignalCycle() {
  unsigned long now     = millis();
  unsigned long elapsed = now - phaseStartMs;

  // ── Emergency override ────────────────────────────────────
  if (emergencyActive) {
    // Lane A is the emergency lane (RC522 mounted there)
    for (int i = 0; i < 4; i++) {
      setSignal(i, i == 0 ? 2 : 0);  // Lane A GREEN, all others RED
    }
    return;
  }

  // ── Normal two-phase adaptive cycle ──────────────────────
  if (!inAmberPhase) {
    // ── GREEN phase ──────────────────────────────────────────
    // Active phase lanes → GREEN, other lanes → RED
    int lane1 = PHASE_LANES[currentPhase][0];
    int lane2 = PHASE_LANES[currentPhase][1];
    // Use the green time the server sent for the first active lane
    // (both lanes in a phase always share the same green duration)
    unsigned long greenMs = (unsigned long)greenTimeSec[lane1] * 1000;

    for (int i = 0; i < 4; i++) {
      if (i == lane1 || i == lane2) setSignal(i, 2);  // GREEN
      else                           setSignal(i, 0);  // RED
    }

    if (elapsed >= greenMs) {
      // Transition both active lanes to AMBER
      setSignal(lane1, 1);
      setSignal(lane2, 1);
      inAmberPhase = true;
      phaseStartMs = now;
      Serial.println("Phase " + String(currentPhase) +
                     " AMBER — switching in " + String(AMBER_SEC) + "s");
    }

  } else {
    // ── AMBER phase ──────────────────────────────────────────
    if (elapsed >= (unsigned long)AMBER_SEC * 1000) {
      // Set current phase lanes RED
      setSignal(PHASE_LANES[currentPhase][0], 0);
      setSignal(PHASE_LANES[currentPhase][1], 0);

      // Switch to next phase
      currentPhase = (currentPhase + 1) % 2;
      inAmberPhase = false;
      phaseStartMs = now;

      int nl1 = PHASE_LANES[currentPhase][0];
      int nl2 = PHASE_LANES[currentPhase][1];
      Serial.println("Phase " + String(currentPhase) +
                     " → Lanes " + String((char)('A'+nl1)) +
                     "+" + String((char)('A'+nl2)) +
                     " GREEN for " + String(greenTimeSec[nl1]) + "s");
    }
  }
}

// ============================================================
//  SECTION 14 — SETUP
// ============================================================

void setup() {
  // ── Serial (must call end before RFID uses GPIO3 for MISO) ─
  Serial.begin(115200);
  delay(500);
  Serial.println("\n====================================");
  Serial.println("  AI Traffic Control System");
  Serial.println("  ESP32-WROOM-32 Firmware");
  Serial.println("====================================");

  // ── LED pins ──────────────────────────────────────────────
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 3; j++) {
      pinMode(LED_PINS[i][j], OUTPUT);
      digitalWrite(LED_PINS[i][j], LOW);
    }
  }
  Serial.println("LED pins initialised.");

  // ── Sensor TRIG pins ──────────────────────────────────────
  for (int i = 0; i < 4; i++) {
    pinMode(SENSOR_PINS[i][0], OUTPUT);
    digitalWrite(SENSOR_PINS[i][0], LOW);
  }
  // ECHO pins are input-only (34, 35, 36, 39) — no pinMode needed for input
  // but we set them explicitly for clarity
  pinMode(ECHO_A, INPUT);
  pinMode(ECHO_B, INPUT);
  pinMode(ECHO_C, INPUT);
  pinMode(ECHO_D, INPUT);
  Serial.println("Sensor pins initialised.");

  // ── Initialise lane states ────────────────────────────────
  for (int i = 0; i < 4; i++) {
    lanes[i] = {0, 0, 0, 0, 0, {}, 0};
    for (int j = 0; j < SENSOR_READINGS; j++) lanes[i].distanceHistory[j] = 400.0;
  }

  // ── RFID ──────────────────────────────────────────────────
  // End Serial before SPI uses GPIO3 (MISO / RX0)
  Serial.end();
  SPI.begin(RFID_SCK_PIN, RFID_MISO_PIN, RFID_MOSI_PIN, RFID_SS_PIN);
  rfid.PCD_Init();
  // Restart Serial after RFID init
  Serial.begin(115200);
  delay(100);
  Serial.println("RC522 RFID initialised.");

  // ── Wi-Fi ─────────────────────────────────────────────────
  connectWiFi();

  // ── TCP ───────────────────────────────────────────────────
  connectTCP();

  // ── Start signal cycle ────────────────────────────────────
  allRed();
  delay(1000);
  phaseStartMs = millis();
  // Phase 0: Lanes A(0) + C(2) start GREEN
  setSignal(0, 2);
  setSignal(2, 2);
  Serial.println("Phase 0 started: Lanes A+C GREEN (horizontal road)");
  Serial.println("====================================");
}

// ============================================================
//  SECTION 15 — MAIN LOOP
// ============================================================

void loop() {
  unsigned long now = millis();

  // ── 1. Run signal cycle (non-blocking, every loop iteration) ─
  runSignalCycle();

  // ── 2. Poll sensors + RFID + send/receive every 2 seconds ───
  if (now - lastPollMs >= POLL_INTERVAL_MS) {
    lastPollMs = now;

    // Poll sensors
    pollSensors();

    // Poll RFID
    pollRFID();

    // Send packet to server
    if (sendPacket()) {
      // Receive and apply timing instructions
      receiveResponse();
    }
  }

  // ── 3. Reconnect Wi-Fi if dropped ────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost — reconnecting...");
    connectWiFi();
    connectTCP();
  }

  delay(10);  // Small yield to prevent watchdog reset
}
