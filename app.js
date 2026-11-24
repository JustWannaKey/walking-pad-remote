"use strict";
// ---- Bluetooth FTMS (Fitness Machine Service) identifiers ----
const FTMS_SERVICE = 0x1826;
const TREADMILL_DATA = 0x2acd;   // notify: live speed, distance, time...
const CONTROL_POINT = 0x2ad9;    // write + indicate: start / stop / set speed
const MACHINE_STATUS = 0x2ada;   // notify: started / stopped / speed changed
const SPEED_RANGE = 0x2ad4;      // read: min / max / increment

const OP = { REQUEST_CONTROL: 0x00, SET_SPEED: 0x02, START: 0x07, STOP_PAUSE: 0x08, RESPONSE: 0x80 };
const RESULT = { 1: "success", 2: "not supported", 3: "invalid parameter", 4: "failed", 5: "control not permitted" };
const KMH_PER_MPH = 1.609344;
const DEMO = new URLSearchParams(location.search).has("demo");

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  connected: false,
  wantConnected: false,
  device: null,
  cp: null,
  speed: 0,              // km/h, as reported by the pad
  target: null,          // km/h, last speed we asked for
  range: { min: 1.0, max: 6.0, inc: 0.1 },
  distance: null,        // metres
  elapsed: null,         // seconds (from pad)
  localElapsed: 0,       // seconds (counted here if pad doesn't send time)
  kcal: null,
  units: store.get("units") === "kmh" ? "kmh" : "mph",
  maxKmh: Number(store.get("maxKmh")) || 4.8,   // user speed limit; default ~3.0 mph
  lastCommandAt: 0,      // when this app last sent a start/speed command
  lastGuardAt: 0,        // when the speed guard last acted
};
const GUARD_TOLERANCE = 0.3; // km/h above the limit before the guard steps in

// ---------- logging ----------
function log(msg) {
  const line = new Date().toLocaleTimeString() + "  " + msg;
  const el = $("log");
  el.textContent = (line + "\n" + el.textContent).split("\n").slice(0, 80).join("\n");
  console.log(msg);
}
const hex = (dv) => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)).map(b => b.toString(16).padStart(2, "0")).join(" ");

// ---------- banner ----------
function showBanner(text, kind = "warn") {
  const b = $("banner");
  b.textContent = text;
  b.className = "banner " + kind;
}
function hideBanner() { $("banner").className = "banner hidden"; }

// ---------- units ----------
const toDisplay = (kmh) => state.units === "mph" ? kmh / KMH_PER_MPH : kmh;
const fromDisplay = (v) => state.units === "mph" ? v * KMH_PER_MPH : v;
const unitLabel = () => state.units === "mph" ? "mph" : "km/h";
const PRESETS = { mph: [1.0, 1.5, 2.0, 2.5, 3.0, 3.5], kmh: [2, 3, 4, 5, 6] };

// ---------- serialized GATT operations ----------
// Bluetooth only allows one operation at a time, so every command waits its turn.
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(() => fn());
  chain = p.catch(() => {});
  return p;
}

let pending = null; // waiting for a control point response
function onControlPointResponse(dv) {
  if (dv.byteLength < 3 || dv.getUint8(0) !== OP.RESPONSE) return;
  const op = dv.getUint8(1), res = dv.getUint8(2);
  log(`Pad replied to 0x${op.toString(16).padStart(2, "0")}: ${RESULT[res] || res}`);
  if (pending && pending.op === op) {
    clearTimeout(pending.timer);
    pending.resolve(res);
    pending = null;
  }
}

// Sends raw bytes to the control point and returns the pad's result code
// (1 = success), or null if it didn't reply within 3 s.
let sendRaw = async (bytes) => enqueue(async () => {
  const op = bytes[0];
  const reply = new Promise((resolve) => {
    pending = { op, resolve, timer: setTimeout(() => { pending = null; resolve(null); }, 3000) };
  });
  const data = new Uint8Array(bytes);
  log("Send " + Array.from(data).map(b => b.toString(16).padStart(2, "0")).join(" "));
  if (state.cp.writeValueWithResponse) await state.cp.writeValueWithResponse(data);
  else await state.cp.writeValue(data);
  return reply;
});

async function command(bytes, label) {
  if (!state.connected) throw new Error("Not connected");
  if (bytes[0] === OP.START || bytes[0] === OP.SET_SPEED) state.lastCommandAt = Date.now();
  let res = await sendRaw(bytes);
  if (res === 5) { // pad wants us to ask for control first
    await sendRaw([OP.REQUEST_CONTROL]);
    res = await sendRaw(bytes);
  }
  if (res === null) { log(`${label}: no reply from pad (it may still have worked)`); return; }
  if (res !== 1) throw new Error(`${label}: ${RESULT[res] || "error " + res}`);
}

// ---------- actions ----------
async function doStop() {
  try {
    await command([OP.STOP_PAUSE, 0x01], "Stop");
    state.target = null;
  } catch (e) {
    log("Stop failed: " + e.message);
    showBanner("Stop command failed. Use the safety key or power switch on the walking pad now.", "err");
  }
  render();
}

async function doStart() {
  try {
    await command([OP.START], "Start");
    hideBanner();
  } catch (e) {
    log(e.message);
    showBanner("The walking pad did not accept Start. " + e.message, "warn");
  }
}

async function setSpeed(kmh) {
  const { min, inc } = state.range;
  const max = Math.min(state.range.max, state.maxKmh);
  kmh = Math.round(kmh / inc) * inc;
  if (kmh > max) kmh = Math.floor(max / inc) * inc;   // round down, never above the limit
  kmh = Math.max(min, kmh);
  const raw = Math.round(kmh * 100);
  state.target = raw / 100;
  render();
  try {
    await command([OP.SET_SPEED, raw & 0xff, (raw >> 8) & 0xff], "Set speed");
  } catch (e) {
    log(e.message);
    showBanner("The walking pad did not accept that speed. " + e.message, "warn");
  }
}

function stepSpeed(dir) {
  const base = state.target ?? state.speed;
  const step = state.units === "mph" ? 0.1 : 0.1;
  let disp = Math.round((toDisplay(base) + dir * step) * 10) / 10;
  let kmh = fromDisplay(disp);
  // Make sure each tap actually changes the speed after rounding to the pad's increment.
  const inc = state.range.inc;
  if (Math.round(kmh / inc) === Math.round(base / inc)) kmh = base + dir * inc;
  setSpeed(kmh);
}

// ---------- incoming data ----------
// Parses an FTMS Treadmill Data packet.
function parseTreadmillData(dv) {
  const out = {};
  if (dv.byteLength < 2) return out;
  const flags = dv.getUint16(0, true);
  const has = (bit) => (flags & (1 << bit)) !== 0;
  let i = 2;
  const fits = (n) => i + n <= dv.byteLength;

  if (!has(0)) { if (!fits(2)) return out; out.speed = dv.getUint16(i, true) / 100; i += 2; }
  if (has(1)) { if (!fits(2)) return out; i += 2; }                       // average speed
  if (has(2)) { if (!fits(3)) return out; out.distance = dv.getUint16(i, true) | (dv.getUint8(i + 2) << 16); i += 3; }
  if (has(3)) { if (!fits(4)) return out; i += 4; }                       // incline + ramp angle
  if (has(4)) { if (!fits(4)) return out; i += 4; }                       // elevation gain

  // Some treadmills send pace as 1 byte, others as 2. Pick whichever makes the length add up.
  const restLen = (paceBytes) => (has(5) ? paceBytes : 0) + (has(6) ? paceBytes : 0) +
    (has(7) ? 5 : 0) + (has(8) ? 1 : 0) + (has(9) ? 1 : 0) + (has(10) ? 2 : 0) + (has(11) ? 2 : 0) + (has(12) ? 4 : 0);
  const remaining = dv.byteLength - i;
  const pace = restLen(1) === remaining ? 1 : restLen(2) === remaining ? 2 : 0;
  if (!pace) return out;
  if (has(5)) i += pace;
  if (has(6)) i += pace;
  if (has(7)) { const k = dv.getUint16(i, true); if (k !== 0xffff) out.kcal = k; i += 5; }
  if (has(8)) i += 1;   // heart rate
  if (has(9)) i += 1;   // MET
  if (has(10)) { out.elapsed = dv.getUint16(i, true); i += 2; }
  return out;
}

// If the belt ever goes faster than the user's limit (for example a command from
// another device), slow it back down and warn. It slows down rather than stopping
// abruptly, because a sudden stop is itself a fall risk.
function speedGuard() {
  if (!state.connected || state.speed <= state.maxKmh + GUARD_TOLERANCE) return;
  if (Date.now() - state.lastGuardAt < 3000) return;
  state.lastGuardAt = Date.now();
  log(`Speed guard: ${state.speed} km/h is above limit ${state.maxKmh} km/h, slowing down`);
  showBanner(`The walking pad went faster than your ${toDisplay(state.maxKmh).toFixed(1)} ${unitLabel()} limit. Slowing it down. Press STOP if anything feels wrong.`, "err");
  setSpeed(state.maxKmh);
}

function applyData(d) {
  if (d.speed !== undefined) {
    state.speed = d.speed;
    speedGuard();
    if (state.target !== null && Math.abs(state.target - d.speed) < 0.05) state.target = null;
  }
  if (d.distance !== undefined) state.distance = d.distance;
  if (d.elapsed !== undefined) state.elapsed = d.elapsed;
  if (d.kcal !== undefined) state.kcal = d.kcal;
  render();
}

function onMachineStatus(dv) {
  const op = dv.getUint8(0);
  const ours = Date.now() - state.lastCommandAt < 4000;
  if ((op === 0x04 || op === 0x05) && !ours) {
    log("Warning: pad changed state without a command from this app");
    showBanner("The walking pad started or changed speed without a command from this app. If that wasn't you, press STOP.", "err");
  }
  if (op === 0x04) log("Pad: started");
  else if (op === 0x02) log("Pad: " + (dv.getUint8(1) === 2 ? "paused" : "stopped"));
  else if (op === 0x05 && dv.byteLength >= 3) log("Pad: target speed now " + (dv.getUint16(1, true) / 100) + " km/h");
  else if (op === 0xff) { log("Pad: control taken by another device"); showBanner("Another device took control of the walking pad.", "warn"); }
  else log("Pad status: " + hex(dv));
}

// ---------- connection ----------
async function connect() {
  if (DEMO) return connectDemo();
  if (!navigator.bluetooth) {
    showBanner("This browser can't use Bluetooth. On iPhone, open this page in the free Bluefy app. On Android, use Chrome.", "err");
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }, { namePrefix: "WELLFIT" }],
      optionalServices: [FTMS_SERVICE],
    });
    state.device = device;
    state.wantConnected = true;
    device.addEventListener("gattserverdisconnected", onDisconnected);
    await setupGatt();
  } catch (e) {
    log("Connect failed: " + e.message);
    if (e.name !== "NotFoundError") showBanner("Couldn't connect: " + e.message, "warn");
    setStatus();
  }
}

async function setupGatt() {
  $("status").textContent = "Connecting…";
  const server = await state.device.gatt.connect();
  const svc = await server.getPrimaryService(FTMS_SERVICE);

  try {
    const r = await (await svc.getCharacteristic(SPEED_RANGE)).readValue();
    state.range = { min: r.getUint16(0, true) / 100, max: r.getUint16(2, true) / 100, inc: (r.getUint16(4, true) / 100) || 0.1 };
    log(`Speed range ${state.range.min}–${state.range.max} km/h, step ${state.range.inc}`);
    renderLimitOptions();
  } catch (e) { log("No speed range info, using defaults"); }

  const cp = await svc.getCharacteristic(CONTROL_POINT);
  cp.addEventListener("characteristicvaluechanged", (e) => onControlPointResponse(e.target.value));
  await cp.startNotifications(); // enables indications; required before writing
  state.cp = cp;

  const data = await svc.getCharacteristic(TREADMILL_DATA);
  data.addEventListener("characteristicvaluechanged", (e) => applyData(parseTreadmillData(e.target.value)));
  await data.startNotifications();

  try {
    const st = await svc.getCharacteristic(MACHINE_STATUS);
    st.addEventListener("characteristicvaluechanged", (e) => onMachineStatus(e.target.value));
    await st.startNotifications();
  } catch (e) { log("No machine status notifications"); }

  state.connected = true;
  log("Connected to " + (state.device.name || "walking pad"));
  hideBanner();
  try { await command([OP.REQUEST_CONTROL], "Request control"); }
  catch (e) { log(e.message); }
  keepAwake();
  render();
}

async function onDisconnected() {
  const wasMoving = state.speed > 0;
  state.connected = false;
  state.cp = null;
  if (pending) { clearTimeout(pending.timer); pending.resolve(null); pending = null; }
  log("Disconnected");
  if (wasMoving) {
    showBanner("Connection lost while the belt was moving. If you need to stop now, use the safety key or power switch. Reconnecting…", "err");
  } else {
    showBanner("Connection lost. Reconnecting…", "warn");
  }
  render();
  for (let attempt = 1; attempt <= 5 && state.wantConnected && !state.connected; attempt++) {
    await new Promise(r => setTimeout(r, attempt * 1000));
    try { await setupGatt(); log("Reconnected"); return; }
    catch (e) { log(`Reconnect attempt ${attempt} failed: ${e.message}`); }
  }
  if (!state.connected) {
    showBanner(wasMoving
      ? "Could not reconnect. Stop the walking pad with its safety key or power switch, then tap Connect."
      : "Could not reconnect. Tap Connect to try again.", wasMoving ? "err" : "warn");
    setStatus();
  }
}

// ---------- keep screen on ----------
let wakeLock = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } }
  catch (e) { /* not supported; fine */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.connected) keepAwake(); });

// ---------- local timer (if the pad doesn't send elapsed time) ----------
setInterval(() => { if (state.connected && state.speed > 0) { state.localElapsed++; if (state.elapsed === null) render(); } }, 1000);

// ---------- rendering ----------
function setStatus() {
  const s = $("status");
  s.textContent = state.connected ? "Connected" : "Not connected";
  s.className = "pill" + (state.connected ? " on" : "");
  $("connectBtn").classList.toggle("hidden", state.connected);
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}

function render() {
  setStatus();
  $("speedVal").textContent = toDisplay(state.speed).toFixed(1);
  $("speedUnit").textContent = unitLabel();
  $("speedSub").textContent = state.target !== null ? `Changing to ${toDisplay(state.target).toFixed(1)} ${unitLabel()}…` :
    (state.connected && state.speed === 0 ? "Belt stopped" : "");
  $("timeVal").textContent = fmtTime(state.elapsed ?? state.localElapsed);
  const dist = state.distance ?? 0;
  $("distVal").textContent = (state.units === "mph" ? dist / 1609.344 : dist / 1000).toFixed(2);
  $("distUnit").textContent = state.units === "mph" ? "Miles" : "Km";
  $("kcalVal").textContent = state.kcal ?? "–";

  const c = state.connected;
  $("stopBtn").disabled = !c;
  $("startBtn").disabled = !c;
  $("fasterBtn").disabled = !c;
  $("slowerBtn").disabled = !c;
  document.querySelectorAll("#presets button").forEach(b => b.disabled = !c || fromDisplay(Number(b.dataset.v)) > state.maxKmh + 0.01);
  document.querySelectorAll("[data-units]").forEach(b => b.classList.toggle("primary", b.dataset.units === state.units));
}

function renderLimitOptions() {
  const sel = $("maxSpeed");
  sel.innerHTML = "";
  const step = state.units === "mph" ? 0.5 : 0.5;
  const top = toDisplay(state.range.max);
  let options = [];
  for (let v = 1; v <= top + 1e-9; v += step) options.push(Math.round(v * 10) / 10);
  if (!options.length) options = [Math.round(top * 10) / 10];
  // keep the stored limit within what the pad supports
  if (state.maxKmh > state.range.max) state.maxKmh = state.range.max;
  let best = options[0];
  for (const v of options) if (fromDisplay(v) <= state.maxKmh + 0.01) best = v;
  for (const v of options) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = `${v.toFixed(1)} ${unitLabel()}`;
    if (v === best) o.selected = true;
    sel.appendChild(o);
  }
  state.maxKmh = fromDisplay(best);
}

function renderPresets() {
  const box = $("presets");
  box.innerHTML = "";
  for (const v of PRESETS[state.units]) {
    const b = document.createElement("button");
    b.textContent = v.toFixed(state.units === "mph" ? 1 : 0);
    b.dataset.v = String(v);
    b.addEventListener("click", () => setSpeed(fromDisplay(v)));
    box.appendChild(b);
  }
}

// ---------- wiring ----------
$("connectBtn").addEventListener("click", connect);
$("stopBtn").addEventListener("click", doStop);
$("startBtn").addEventListener("click", doStart);
$("fasterBtn").addEventListener("click", () => stepSpeed(+1));
$("slowerBtn").addEventListener("click", () => stepSpeed(-1));
document.querySelectorAll("[data-units]").forEach(b => b.addEventListener("click", () => {
  state.units = b.dataset.units; store.set("units", state.units); renderLimitOptions(); renderPresets(); render();
}));

// ---------- demo mode (open with ?demo to try the screen without a walking pad) ----------
function connectDemo() {
  const sim = { speed: 0, target: 0, running: false, dist: 0, t: 0 };
  sendRaw = async (bytes) => {
    log("Demo send " + bytes.map(b => b.toString(16).padStart(2, "0")).join(" "));
    if (bytes[0] === OP.START) { sim.running = true; sim.target = Math.max(sim.target, state.range.min); }
    if (bytes[0] === OP.STOP_PAUSE) { sim.running = false; sim.target = 0; }
    if (bytes[0] === OP.SET_SPEED && sim.running) sim.target = (bytes[1] | (bytes[2] << 8)) / 100;
    return 1;
  };
  state.connected = true; state.wantConnected = true;
  setInterval(() => {
    sim.speed += Math.max(-0.3, Math.min(0.3, sim.target - sim.speed));
    if (Math.abs(sim.target - sim.speed) < 0.01) sim.speed = sim.target;
    if (sim.speed > 0) { sim.t++; sim.dist += sim.speed / 3.6; }
    applyData({ speed: Math.round(sim.speed * 100) / 100, distance: Math.round(sim.dist), elapsed: sim.t, kcal: Math.round(sim.dist / 20) });
  }, 1000);
  log("Demo mode connected");
  render();
}

$("maxSpeed").addEventListener("change", (e) => {
  state.maxKmh = fromDisplay(Number(e.target.value));
  store.set("maxKmh", String(state.maxKmh));
  log(`Speed limit set to ${state.maxKmh.toFixed(2)} km/h`);
  if ((state.target ?? state.speed) > state.maxKmh + 0.01) setSpeed(state.maxKmh);
  render();
});

renderLimitOptions();
renderPresets();
render();
if (DEMO) $("connectBtn").textContent = "Connect (demo)";
