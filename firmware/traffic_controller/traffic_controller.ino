// ============================================================
//  AI TRAFFIC CONTROL SYSTEM — ESP32 FIRMWARE
//  KNUST Department of Computer Engineering
//
//  Speaks the protocol in server/server.py:
//    - raw TCP to port 5050, newline-delimited JSON
//    - sends  laneX_count / laneX_wait / laneX_activation  per lane
//    - receives laneX_signal (RED/YELLOW/GREEN) and applies it
//
//  DIVISION OF RESPONSIBILITY
//    The SERVER owns the phase sequence. It decides which lanes are
//    green and for how long, on its own wall-clock ticker. This board
//    reports what the sensors see and drives the lamps it is told to.
//    It only runs its own phase logic if the server is unreachable.
//
//  LANE GEOMETRY (must match server PHASE_LANES)
//    Lane A = West    Lane C = East    -> served together (EW phase)
//    Lane B = North   Lane D = South   -> served together (NS phase)
//
//    Opposing approaches run together because their movements do not
//    conflict. Lanes are driven individually here, so the pairing is
//    the server's decision, not a wiring assumption.
// ============================================================

#include <WiFi.h>
#include <ArduinoJson.h>

// RFID stays off until its SPI pins are freed. See notes at end.
#define ENABLE_RFID 0

#if ENABLE_RFID
  #include <SPI.h>
  #include <MFRC522.h>
  #define RFID_SS   5
  #define RFID_RST  22
  MFRC522 rfid(RFID_SS, RFID_RST);
#endif


// ============================================================
//  NETWORK
// ============================================================

const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char* SERVER_HOST = "192.168.1.100";   // laptop running run.py
const int   SERVER_PORT = 5050;              // matches server.py PORT

const unsigned long SEND_INTERVAL     = 2000;   // ms between packets
const unsigned long RECONNECT_BACKOFF = 3000;
const unsigned long LINK_TIMEOUT      = 6000;   // no reply for this long = offline


// ============================================================
//  PIN MAP — verified working build, do not change casually
// ============================================================

const int NUM_LANES = 4;
const char* LANE_ID[NUM_LANES] = { "A", "B", "C", "D" };

//                                   A    B    C    D
const int TRIG_PIN[NUM_LANES]  = {  25,  26,  27,  14 };
const int ECHO_PIN[NUM_LANES]  = {  34,  35,  32,  33 };

const int RED_PIN[NUM_LANES]   = {   4,  23,  18,  21 };
const int GREEN_PIN[NUM_LANES] = {   5,  22,  19,  13 };


// ============================================================
//  DETECTION AND WINDOWING
// ============================================================

const float DETECTION_DISTANCE = 20.0;    // cm — vehicle present below this
const float MIN_VALID_CM       = 2.0;
const float MAX_VALID_CM       = 400.0;

const unsigned long SAMPLE_INTERVAL = 120;    // ms between single-lane samples
const unsigned long PULSE_TIMEOUT   = 30000;  // us

const int MEDIAN_WINDOW = 3;
const int CLEAR_SAMPLES = 3;     // consecutive clears before counting a new arrival
const int OCC_WINDOW    = 25;    // samples ≈ 12 s, matching the model's activation range

// Each lane is sampled every NUM_LANES * SAMPLE_INTERVAL ms.
const float SAMPLE_PERIOD_S = (SAMPLE_INTERVAL * NUM_LANES) / 1000.0;

// Queue estimation
const int           QUEUE_MAX       = 15;     // matches the dashboard's render cap
const unsigned long QUEUE_FLUSH_MS  = 2500;   // clear-on-green before declaring empty
const float         ACTIVATION_PER_VEHICLE = 0.7;   // dataset uses count x 0.3-0.9

// Local fallback timings, used only when the server is unreachable.
const unsigned long FB_GREEN_LOW    = 12000;
const unsigned long FB_GREEN_MEDIUM = 20000;
const unsigned long FB_GREEN_HIGH   = 35000;
const unsigned long FB_YELLOW       = 3000;
const unsigned long FB_ALL_RED      = 1500;


// ============================================================
//  LANE STATE
// ============================================================

struct Lane {
  float raw[MEDIAN_WINDOW];
  int   rawIdx, rawFilled;

  float distance;
  bool  present;
  bool  armed;
  int   clearRun;

  int   count;            // debounced arrival events since last packet
  bool  occ[OCC_WINDOW];
  int   occIdx, occFilled;

  unsigned long presentSince;
  unsigned long waitAccum;

  // ---- queue estimate ----
  // The dataset defines vehicle_count as "estimated vehicles in lane"
  // (0-2 low, 3-5 medium, 6+ high), i.e. a standing queue rather than a
  // flow rate. A single presence sensor cannot measure queue length
  // directly, so it is integrated from arrivals and departures.
  int   queue;
  unsigned long clearSince;   // millis the lane has read clear on green

  char  signal[8];        // RED / YELLOW / GREEN as sent by the server
  int   greenRemaining;
};

Lane lanes[NUM_LANES];

int activeLane = 0;
unsigned long lastSampleAt = 0;
unsigned long lastSendAt   = 0;
unsigned long lastReplyAt  = 0;
unsigned long lastConnectTry = 0;

WiFiClient client;
String rxBuffer = "";

bool serverLinked   = false;
bool emergencyFlag  = false;     // set by RFID, cleared once acknowledged
String lastTagId    = "";

// Fallback FSM
enum FbState { FB_EW_GREEN, FB_EW_YELLOW, FB_EW_RED, FB_NS_GREEN, FB_NS_YELLOW, FB_NS_RED };
FbState fbState = FB_NS_RED;
unsigned long fbStateStart = 0;
unsigned long fbStateDur   = FB_ALL_RED;

unsigned long yellowBlinkAt = 0;
bool yellowBlinkOn = false;


// ============================================================
//  SENSOR READING
// ============================================================

float readDistanceRaw(int trigPin, int echoPin)
{
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long dur = pulseIn(echoPin, HIGH, PULSE_TIMEOUT);
  if (dur == 0) return -1.0;

  float cm = dur * 0.0343 / 2.0;
  if (cm < MIN_VALID_CM || cm > MAX_VALID_CM) return -1.0;
  return cm;
}


// Median rejects the single wild reading ultrasonic modules throw out
// occasionally, without smearing it into later samples the way an
// averaging filter would.
float medianOf(Lane &L)
{
  float v[MEDIAN_WINDOW];
  int n = 0;
  for (int i = 0; i < L.rawFilled; i++) if (L.raw[i] > 0) v[n++] = L.raw[i];
  if (n == 0) return -1.0;

  for (int i = 1; i < n; i++) {
    float k = v[i]; int j = i - 1;
    while (j >= 0 && v[j] > k) { v[j+1] = v[j]; j--; }
    v[j+1] = k;
  }
  return v[n/2];
}


void sampleLane(int idx)
{
  Lane &L = lanes[idx];

  float raw = readDistanceRaw(TRIG_PIN[idx], ECHO_PIN[idx]);
  L.raw[L.rawIdx] = raw;
  L.rawIdx = (L.rawIdx + 1) % MEDIAN_WINDOW;
  if (L.rawFilled < MEDIAN_WINDOW) L.rawFilled++;

  L.distance = medianOf(L);
  bool nowPresent = (L.distance > 0 && L.distance <= DETECTION_DISTANCE);

  L.occ[L.occIdx] = nowPresent;
  L.occIdx = (L.occIdx + 1) % OCC_WINDOW;
  if (L.occFilled < OCC_WINDOW) L.occFilled++;

  bool onGreen = (strcmp(L.signal, "GREEN") == 0);

  if (nowPresent) {
    L.clearRun = 0;
    L.clearSince = 0;

    if (L.armed) {
      L.count++;
      L.armed = false;

      // A detection event means a vehicle crossed the sensor. On red it
      // has joined the back of the queue; on green it is discharging.
      if (onGreen) { if (L.queue > 0) L.queue--; }
      else         { if (L.queue < QUEUE_MAX) L.queue++; }
    }

    // Continuous presence on red means at least one vehicle is standing
    // at the line, even if no fresh edge was seen.
    if (!onGreen && L.queue < 1) L.queue = 1;

    if (!L.present) L.presentSince = millis();

  } else {
    L.clearRun++;
    if (L.clearRun >= CLEAR_SAMPLES) L.armed = true;

    if (L.present && L.presentSince > 0) {
      L.waitAccum += millis() - L.presentSince;
      L.presentSince = 0;
    }

    // Sustained clear on green means the queue has fully discharged.
    if (onGreen) {
      if (L.clearSince == 0) L.clearSince = millis();
      else if (millis() - L.clearSince > QUEUE_FLUSH_MS) L.queue = 0;
    } else {
      L.clearSince = 0;
    }
  }

  L.present = nowPresent;
}


// Seconds the sensor was occupied within the window.
//
// The model was trained on activation ≈ vehicle_count x 0.3..0.9, so a
// six-vehicle queue sits around 4-5 s. A raw occupied-seconds figure
// saturates at the full window length once a queue stands on the sensor,
// which falls outside that range. The measured value is therefore capped
// against what the queue estimate implies, keeping the feature inside the
// distribution the classifier actually saw.
float activationOf(Lane &L)
{
  if (L.occFilled == 0) return 0.0;

  int hits = 0;
  for (int i = 0; i < L.occFilled; i++) if (L.occ[i]) hits++;
  float measured = hits * SAMPLE_PERIOD_S;

  float implied = L.queue * ACTIVATION_PER_VEHICLE;
  return (measured < implied) ? measured : implied;
}


float waitSecondsOf(Lane &L)
{
  unsigned long w = L.waitAccum;
  if (L.present && L.presentSince > 0) w += millis() - L.presentSince;
  return w / 1000.0;
}


// Counts and wait reset each reporting window so the server sees a rate,
// not an ever-growing total. The queue estimate deliberately persists —
// it represents standing vehicles, not events in the last window.
void resetWindow(Lane &L)
{
  L.count = 0;
  L.waitAccum = 0;
  L.presentSince = L.present ? millis() : 0;
}


// ============================================================
//  LAMPS
//
//  The hardware has red and green only. A YELLOW instruction is shown
//  as a flashing red — visually distinct from steady red, and it fails
//  safe, since a driver reading it as "stop" is the correct response.
// ============================================================

void applySignal(int idx, const char* sig)
{
  bool isGreen  = (strcmp(sig, "GREEN")  == 0);
  bool isYellow = (strcmp(sig, "YELLOW") == 0);

  if (isGreen) {
    digitalWrite(RED_PIN[idx], LOW);
    digitalWrite(GREEN_PIN[idx], HIGH);
  } else if (isYellow) {
    digitalWrite(GREEN_PIN[idx], LOW);
    digitalWrite(RED_PIN[idx], yellowBlinkOn ? HIGH : LOW);
  } else {
    digitalWrite(GREEN_PIN[idx], LOW);
    digitalWrite(RED_PIN[idx], HIGH);
  }
}


void refreshLamps()
{
  unsigned long now = millis();
  if (now - yellowBlinkAt >= 250) {
    yellowBlinkAt = now;
    yellowBlinkOn = !yellowBlinkOn;
  }
  for (int i = 0; i < NUM_LANES; i++) applySignal(i, lanes[i].signal);
}


void setAllRed()
{
  for (int i = 0; i < NUM_LANES; i++) strcpy(lanes[i].signal, "RED");
}


// ============================================================
//  RFID
// ============================================================

void checkRFID()
{
#if ENABLE_RFID
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial())   return;

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  lastTagId     = uid;
  emergencyFlag = true;

  // The server holds the cooldown and decides when it is safe to grant
  // priority. This board only reports the tag.
  Serial.print("[RFID] tag ");
  Serial.println(uid);
#endif
}


// ============================================================
//  SERVER LINK
// ============================================================

void ensureWifi()
{
  if (WiFi.status() == WL_CONNECTED) return;
  static unsigned long lastTry = 0;
  if (millis() - lastTry < 5000) return;
  lastTry = millis();
  Serial.println("[WIFI] connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}


void ensureServer()
{
  if (client.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastConnectTry < RECONNECT_BACKOFF) return;

  lastConnectTry = millis();
  Serial.printf("[TCP] connecting to %s:%d ...\n", SERVER_HOST, SERVER_PORT);

  if (client.connect(SERVER_HOST, SERVER_PORT)) {
    Serial.println("[TCP] connected");
    rxBuffer = "";
    lastReplyAt = millis();
  }
}


void sendPacket()
{
  if (!client.connected()) return;

  StaticJsonDocument<512> doc;
  doc["timestamp"] = (uint32_t)(millis() / 1000);
  doc["source"]    = "device";
  doc["emergency"] = emergencyFlag ? "1" : "0";

  for (int i = 0; i < NUM_LANES; i++) {
    String base = String("lane") + LANE_ID[i];
    doc[base + "_count"]      = lanes[i].queue;   // estimated vehicles in lane
    doc[base + "_wait"]       = waitSecondsOf(lanes[i]);
    doc[base + "_activation"] = activationOf(lanes[i]);
  }

  String out;
  serializeJson(doc, out);
  out += "\n";                       // server splits on newline
  client.print(out);

  // Flag is one-shot; the server queues the request from here.
  emergencyFlag = false;

  for (int i = 0; i < NUM_LANES; i++) resetWindow(lanes[i]);
}


void readReplies()
{
  while (client.available()) {
    char c = client.read();
    if (c == '\n') {
      String line = rxBuffer;
      rxBuffer = "";
      line.trim();
      if (line.length() == 0) continue;

      StaticJsonDocument<640> resp;
      if (deserializeJson(resp, line)) continue;

      for (int i = 0; i < NUM_LANES; i++) {
        String sigKey = String("lane") + LANE_ID[i] + "_signal";
        String grnKey = String("lane") + LANE_ID[i] + "_green";

        const char* sig = resp[sigKey] | "RED";
        strncpy(lanes[i].signal, sig, sizeof(lanes[i].signal) - 1);
        lanes[i].signal[sizeof(lanes[i].signal) - 1] = '\0';

        lanes[i].greenRemaining = resp[grnKey] | 0;
      }

      lastReplyAt  = millis();
      serverLinked = true;

      const char* ps = resp["phase_state"] | "";
      Serial.printf("[SRV] %s  A:%s B:%s C:%s D:%s\n", ps,
                    lanes[0].signal, lanes[1].signal,
                    lanes[2].signal, lanes[3].signal);
    } else {
      if (rxBuffer.length() < 900) rxBuffer += c;
      else rxBuffer = "";           // discard a malformed oversized line
    }
  }
}


// ============================================================
//  LOCAL FALLBACK
//
//  Runs only when the server has gone quiet. Mirrors the server's own
//  sequence so behaviour does not change shape when the link drops:
//  NS green -> NS yellow -> all red -> EW green -> EW yellow -> all red.
//  Green length comes from a local reading of count and wait, using the
//  same thresholds the model was trained against.
// ============================================================

int localClass(int idx)
{
  int c = lanes[idx].queue;
  float w = waitSecondsOf(lanes[idx]);

  int byCount = (c >= 6) ? 2 : (c >= 3) ? 1 : 0;
  int byWait  = (w > 25) ? 2 : (w > 10) ? 1 : 0;
  return byCount > byWait ? byCount : byWait;
}


unsigned long fallbackGreenFor(int laneA, int laneB)
{
  int lvl = localClass(laneA);
  int o   = localClass(laneB);
  if (o > lvl) lvl = o;

  if (lvl >= 2) return FB_GREEN_HIGH;
  if (lvl == 1) return FB_GREEN_MEDIUM;
  return FB_GREEN_LOW;
}


void fbEnter(FbState s, unsigned long dur)
{
  fbState = s;
  fbStateStart = millis();
  fbStateDur = dur;

  setAllRed();
  switch (s) {
    case FB_NS_GREEN:  strcpy(lanes[1].signal, "GREEN");  strcpy(lanes[3].signal, "GREEN");  break;
    case FB_NS_YELLOW: strcpy(lanes[1].signal, "YELLOW"); strcpy(lanes[3].signal, "YELLOW"); break;
    case FB_EW_GREEN:  strcpy(lanes[0].signal, "GREEN");  strcpy(lanes[2].signal, "GREEN");  break;
    case FB_EW_YELLOW: strcpy(lanes[0].signal, "YELLOW"); strcpy(lanes[2].signal, "YELLOW"); break;
    default: break;
  }
}


void runFallback()
{
  if (millis() - fbStateStart < fbStateDur) return;

  switch (fbState) {
    case FB_NS_GREEN:  fbEnter(FB_NS_YELLOW, FB_YELLOW);  break;
    case FB_NS_YELLOW: fbEnter(FB_NS_RED,    FB_ALL_RED); break;
    case FB_NS_RED:    fbEnter(FB_EW_GREEN,  fallbackGreenFor(0, 2)); break;
    case FB_EW_GREEN:  fbEnter(FB_EW_YELLOW, FB_YELLOW);  break;
    case FB_EW_YELLOW: fbEnter(FB_EW_RED,    FB_ALL_RED); break;
    case FB_EW_RED:    fbEnter(FB_NS_GREEN,  fallbackGreenFor(1, 3)); break;
  }
}


// ============================================================
//  TELEMETRY
// ============================================================

void printStatus()
{
  Serial.println("------------------------------------------------");
  for (int i = 0; i < NUM_LANES; i++) {
    Serial.printf("Lane %s  ", LANE_ID[i]);
    if (lanes[i].distance < 0) Serial.print("  --   ");
    else                        Serial.printf("%6.1fcm", lanes[i].distance);
    Serial.printf("  q=%-2d  wait=%5.1fs  act=%5.1fs  %s\n",
                  lanes[i].queue, waitSecondsOf(lanes[i]),
                  activationOf(lanes[i]), lanes[i].signal);
  }
  Serial.printf("wifi=%s  server=%s\n",
                WiFi.status() == WL_CONNECTED ? "ok" : "down",
                serverLinked ? "linked" : "FALLBACK");
}


// ============================================================
//  SETUP
// ============================================================

void setup()
{
  Serial.begin(115200);
  delay(300);

  for (int i = 0; i < NUM_LANES; i++) {
    lanes[i] = Lane();
    lanes[i].distance = -1;
    lanes[i].armed = true;
    lanes[i].clearRun = CLEAR_SAMPLES;
    lanes[i].queue = 0;
    lanes[i].clearSince = 0;
    strcpy(lanes[i].signal, "RED");

    pinMode(TRIG_PIN[i], OUTPUT);
    pinMode(ECHO_PIN[i], INPUT);
    digitalWrite(TRIG_PIN[i], LOW);

    pinMode(RED_PIN[i], OUTPUT);
    pinMode(GREEN_PIN[i], OUTPUT);
    digitalWrite(RED_PIN[i], HIGH);
    digitalWrite(GREEN_PIN[i], LOW);
  }

#if ENABLE_RFID
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("[RFID] reader ready");
#endif

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println("\n================================================");
  Serial.println("  AI TRAFFIC CONTROL — ESP32 NODE");
  Serial.println("  Lane A West · B North · C East · D South");
  Serial.println("================================================");

  fbEnter(FB_NS_RED, FB_ALL_RED);
}


// ============================================================
//  MAIN LOOP
//
//  One pulseIn per pass at most, so the loop never stalls long enough
//  to miss a server reply or an RFID tag.
// ============================================================

void loop()
{
  unsigned long now = millis();

  if (now - lastSampleAt >= SAMPLE_INTERVAL) {
    lastSampleAt = now;
    sampleLane(activeLane);
    activeLane = (activeLane + 1) % NUM_LANES;
  }

  checkRFID();

  ensureWifi();
  ensureServer();
  readReplies();

  if (now - lastSendAt >= SEND_INTERVAL) {
    lastSendAt = now;
    if (client.connected()) sendPacket();
    printStatus();
  }

  // Link considered down if no reply has arrived recently.
  if (serverLinked && (now - lastReplyAt > LINK_TIMEOUT)) {
    serverLinked = false;
    Serial.println("[TCP] link lost — switching to local fallback");
    fbEnter(FB_NS_RED, FB_ALL_RED);
  }

  if (!serverLinked) runFallback();

  refreshLamps();
}


// ============================================================
//  NOTES
//
//  1. Before flashing
//     Set WIFI_SSID, WIFI_PASSWORD and SERVER_HOST. SERVER_HOST is the
//     laptop running run.py — get it from `ipconfig` (IPv4 address).
//     Port 5050 matches server.py; do not change one without the other.
//
//  2. Check which sensor is on which approach
//     The code assumes sensor order A=West, B=North, C=East, D=South,
//     matching the server's PHASE_LANES pairing of A+C and B+D. If your
//     sensors are physically ordered differently, reorder TRIG_PIN and
//     ECHO_PIN rather than changing the lane letters — the server pairs
//     lanes by letter and pairing perpendicular approaches would give
//     two conflicting movements green at once.
//
//  3. Yellow on red/green hardware
//     A YELLOW instruction flashes the red lamp. Add real amber LEDs and
//     this becomes a one-line change in applySignal().
//
//  4. Enabling RFID
//     RC522 needs GPIO 5, 18, 19, 22, 23 — currently LED pins. Free them
//     by moving these five, then set ENABLE_RFID to 1:
//       ECHO_C 32 -> 36 (VP)     ECHO_D 33 -> 39 (VN)
//       GREEN_A 5 -> 16          RED_B  23 -> 17
//       GREEN_B 22 -> 32         RED_C  18 -> 33
//       GREEN_C 19 -> 2
//     VP and VN are input-only, so moving the echoes there frees two
//     output-capable pins.
//
//  5. Do not use the pin table in hardware/pin_assignment.md
//     It assigns TRIG lines to GPIO 0, 2, 12 and 15, and RFID MOSI/MISO
//     to GPIO 0 and 3. Those are strapping pins and the USB serial pair.
//     That table predates the working build.
// ============================================================
