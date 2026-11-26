/**
 * Fishing pomodoro: cast at the pond's edge, choose how many minutes to focus, and when the time
 * is up a fish bites (a sound plays) and you have PULL_WINDOW to pull it in. Client-only.
 */
import * as THREE from "three";
import "./fishing.css";

const FAST = import.meta.env.DEV && new URLSearchParams(location.search).has("fast");
const MIN = FAST ? 1000 : 60000;
const PULL_WINDOW = 60000;
const PLOP_EVERY = 4000;
const MINUTES = [15, 25, 50];
const MAX_MINUTES = 180;
export const FISH_NEAR = 2.4;
export const FISH_LEAVE = 2;
const CONFIRM_MS = 3000;

const FW = 24,
  FH = 12;
const OUTLINE = "#1b1b24";
const C = { back: "#55666f", side: "#8496a2", belly: "#c9d2d8", bars: "#46525c", fin: "#9a5a5a" };
/**
 * Draws the fish in pixel art, facing left.
 * @param {number} P size of one pixel on screen
 * @returns {HTMLCanvasElement}
 */
function fishCanvas(P) {
  const g = Array.from({ length: FH }, () => Array(FW).fill(null));
  const set = (x, y, col) => x >= 0 && x < FW && y >= 0 && y < FH && (g[y][x] = col);
  const x0 = 2,
    len = 15,
    h = 8,
    cy = (FH - 1) / 2;
  const half = (x) => (h / 2) * Math.sqrt(Math.max(0, 1 - (((x - x0) / (len - 1) - 0.42) / 0.6) ** 2));
  for (let x = x0; x < x0 + len; x++)
    for (let y = 0; y < FH; y++) {
      const d = (y - cy) / Math.max(half(x), 0.5);
      if (Math.abs(y - cy) > half(x)) continue;
      const bar = d < 0.45 && x - x0 > 3 && x - x0 < 13 && (x - x0) % 4 === 2;
      set(x, y, bar ? C.bars : d < -0.35 ? C.back : d > 0.4 ? C.belly : C.side);
    }
  const xt = x0 + len - 1;
  for (let i = 1; i <= 5; i++) {
    const spread = 1 + i * 0.85;
    for (let y = 0; y < FH; y++) {
      const d = Math.abs(y - cy);
      if (d <= spread && !(i > 3 && d < spread - 2)) set(xt + i, y, C.fin);
    }
  }
  for (let x = x0 + 5; x <= x0 + 9; x++) set(x, Math.ceil(cy - half(x)) - 1, C.fin);
  set(x0 + 2, Math.round(cy - 1), OUTLINE);
  set(x0, Math.round(cy + 1), OUTLINE);
  const cv = Object.assign(document.createElement("canvas"), { width: FW * P, height: FH * P });
  const c = cv.getContext("2d");
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) {
      const col = g[y][x] || ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => g[y + b]?.[x + a]) ? OUTLINE : null);
      if (col) (c.fillStyle = col), c.fillRect(x * P, y * P, P, P);
    }
  return cv;
}

const load = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const save = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

let audio = null;
/** Starts the audio context; browsers only allow it after a click or key on the page. */
const unlockAudio = () => {
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { audio ??= new AudioContext(); audio.resume(); } catch {}
};
/**
 * Plays a short sine sweep.
 * @param {number} freq start frequency (Hz)
 * @param {number} to end frequency (Hz)
 * @param {number} start delay (s)
 * @param {number} dur length (s)
 * @param {number} [vol]
 */
function tone(freq, to, start, dur, vol = 0.18) {
  if (!audio) return;
  const t = audio.currentTime + start;
  const o = audio.createOscillator(),
    g = audio.createGain();
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}
const plop = () => (tone(700, 180, 0, 0.16), tone(650, 170, 0.32, 0.16));

/** @param {number} ms @returns {string} "m:ss" */
const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Creates the fishing line: rod, line and bobber in the scene, the minutes box, the catch card and
 * the timer. A line that is out is kept in localStorage, so it survives a reload.
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {HTMLButtonElement} o.button HUD button that shows the time left
 * @param {(text: string) => void} o.say bubble over your trainer (only you see it)
 */
export function createFishing({ scene, button, say }) {
  let state = load("fishing", { phase: "idle" });
  if (state?.phase !== "out") state = { phase: "idle" };
  let confirmUntil = 0,
    lastPlop = 0;
  const setState = (s) => save("fishing", (state = s));

  /** @returns {"idle" | "focus" | "bite"} */
  const phase = (now = Date.now()) => (state.phase !== "out" ? "idle" : now < state.end ? "focus" : "bite");

  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1, 6), new THREE.MeshLambertMaterial({ color: "#8a5a2e" }));
  const LINE_PTS = 16;
  const line = new THREE.Line(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(LINE_PTS * 3), 3)),
    new THREE.LineBasicMaterial({ color: "#e9e6dc", transparent: true, opacity: 0.75 }),
  );
  line.frustumCulled = false;
  const bobber = new THREE.Group();
  const half = (color, flip) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.25, flatShading: true }),
    );
    if (flip) m.rotation.x = Math.PI;
    return m;
  };
  bobber.add(half("#e0402a"), half("#f2efe6", true));
  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.4, 24),
    new THREE.MeshBasicMaterial({ color: "#cfe6ff", transparent: true, opacity: 0, depthWrite: false }),
  );
  ripple.rotation.x = -Math.PI / 2;
  const gear = [rod, line, bobber, ripple];
  gear.forEach((o) => ((o.visible = false), scene.add(o)));

  const _hand = new THREE.Vector3(),
    _tip = new THREE.Vector3(),
    _up = new THREE.Vector3(0, 1, 0),
    _d = new THREE.Vector3();
  const SIDE = { down: [0.9, 0.3, 1.4], up: [-0.7, 0, -0.6], left: [0, 0.3, 0], right: [0, 0.3, 0] };
  /**
   * Places the rod, line and bobber for this frame (hidden while idle).
   * @param {number} now Date.now()
   * @param {{x: number, y: number, z: number, dir: string}} trainer
   * @param {[number, number]} facing direction the line was cast to
   */
  function draw(now, trainer, facing) {
    const p = phase(now);
    gear.forEach((o) => (o.visible = p !== "idle"));
    if (p === "idle") return;
    const t = now / 1000;
    const { x: tx, y: ty, z: tz } = state.target;
    const tug = p === "bite" ? Math.max(0, Math.sin(t * 9)) * 0.28 : 0;
    bobber.position.set(tx, ty + 0.06 + Math.sin(t * 1.8) * 0.04 - tug, tz);
    const period = p === "bite" ? 0.7 : 2.6;
    const k = (t % period) / period;
    ripple.position.set(tx, ty + 0.02, tz);
    ripple.scale.setScalar(1 + k * (p === "bite" ? 4 : 2.5));
    ripple.material.opacity = (1 - k) * (p === "bite" ? 0.6 : 0.3);
    const [sx, sz, lean] = SIDE[trainer.dir] || SIDE.down;
    _hand.set(trainer.x + sx, trainer.y + 1.7, trainer.z + sz);
    _tip.set(_hand.x + facing[0] * 2.2 + lean, _hand.y + 1.5 + (p === "bite" ? -0.3 + Math.sin(t * 9) * 0.15 : 0), _hand.z + facing[1] * 2.2);
    _d.subVectors(_tip, _hand);
    rod.position.copy(_hand).addScaledVector(_d, 0.5);
    rod.scale.set(1, _d.length(), 1);
    rod.quaternion.setFromUnitVectors(_up, _d.normalize());
    const pos = line.geometry.attributes.position;
    const sag = p === "bite" ? 0.1 : 0.9;
    for (let i = 0; i < LINE_PTS; i++) {
      const u = i / (LINE_PTS - 1);
      pos.setXYZ(
        i,
        _tip.x + (bobber.position.x - _tip.x) * u,
        _tip.y + (bobber.position.y + 0.2 - _tip.y) * u - Math.sin(Math.PI * u) * sag,
        _tip.z + (bobber.position.z - _tip.z) * u,
      );
    }
    pos.needsUpdate = true;
  }

  const picker = Object.assign(document.createElement("form"), { id: "fish-time", className: "glass", hidden: true });
  picker.innerHTML =
    '<b>focus for how long?</b><div class="quick"></div><label><input inputmode="numeric" maxlength="3" autocomplete="off" aria-label="minutes" /> min</label><button type="submit">cast</button><small>Enter casts · Esc cancels</small>';
  const field = picker.querySelector("input");
  for (const m of MINUTES) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: `${m}` });
    b.addEventListener("click", () => ((field.value = m), picker.requestSubmit()));
    picker.querySelector(".quick").append(b);
  }
  document.body.append(picker);
  let onPick = null;
  const closePicker = () => {
    picker.hidden = true;
    onPick = null;
    field.blur();
  };
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") closePicker();
  });
  field.addEventListener("input", () => (field.value = field.value.replace(/\D/g, "")));
  picker.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!+field.value) return field.focus();
    const m = Math.min(MAX_MINUTES, Math.round(+field.value));
    save("fish-minutes", m);
    const done = onPick;
    closePicker();
    done?.(m);
  });
  /**
   * Opens the minutes box, filled with the last choice.
   * @param {(minutes: number) => void} cast called with the chosen minutes
   */
  function choose(cast) {
    onPick = cast;
    field.value = load("fish-minutes", 25);
    picker.hidden = false;
    field.focus();
    field.select();
  }

  const card = Object.assign(document.createElement("div"), { id: "catch", className: "glass", hidden: true });
  card.append(fishCanvas(4), Object.assign(document.createElement("p"), { className: "txt" }));
  document.body.append(card);
  let cardTimer = 0;

  /**
   * @param {{x: number, z: number, face: string, seat: number, target: {x: number, y: number, z: number}}} spot
   *   where you cast from and where the bobber lands
   * @param {number} minutes
   */
  function cast(spot, minutes) {
    unlockAudio();
    card.hidden = true;
    setState({ phase: "out", end: Date.now() + minutes * MIN, minutes, ...spot });
    tone(500, 260, 0, 0.12, 0.12);
    say(`line's out: ${minutes} min of focus`);
  }
  /** Brings the line back without a fish. @param {string} [text] bubble to show */
  function reelIn(text = "the fish got away") {
    if (state.phase !== "out") return;
    setState({ phase: "idle" });
    confirmUntil = 0;
    if (text) say(text);
  }
  function pull() {
    const minutes = state.minutes;
    setState({ phase: "idle" });
    card.querySelector(".txt").textContent = `you caught a fish! ${minutes} min of focus done`;
    card.hidden = false;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => (card.hidden = true), 6000);
  }
  /** E while the line is out: pulls on a bite, otherwise reels in on the second press. */
  function press(now = Date.now()) {
    const p = phase(now);
    if (p === "bite") return pull();
    if (p !== "focus") return;
    if (now < confirmUntil) return reelIn("line's in. no fish this time");
    confirmUntil = now + CONFIRM_MS;
  }

  const baseTitle = document.title;
  const icon = button.querySelector("svg").outerHTML;
  /** Runs on an interval, so the timer and the sound keep going with the tab hidden. */
  function tick() {
    const now = Date.now();
    const p = phase(now);
    if (p === "bite") {
      if (now >= state.end + PULL_WINDOW) {
        reelIn("too slow: the fish got away");
        return tick();
      }
      if (now - lastPlop >= PLOP_EVERY) (lastPlop = now), unlockAudio(), plop();
    }
    const left = p === "bite" ? state.end + PULL_WINDOW - now : state.end - now;
    const title = p === "focus" ? `🎣 ${clock(left)} · ${baseTitle}` : p === "bite" ? `🐟 pull! · ${baseTitle}` : baseTitle;
    if (document.title !== title) document.title = title;
    const text = p === "focus" ? clock(left) : p === "bite" ? `pull! ${Math.ceil(left / 1000)}` : "";
    const confirming = p === "focus" && now < confirmUntil;
    button.classList.toggle("timer", !!text);
    button.classList.toggle("bite", p === "bite");
    button.classList.toggle("confirm", confirming);
    const label = confirming ? "press again to reel in" : p === "focus" ? "reel in (E)" : p === "bite" ? "pull it in! (E)" : "fish (E by the pond)";
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
    const html = icon + (text ? `<span>${text}</span>` : "");
    if (button.dataset.html !== html) (button.innerHTML = html), (button.dataset.html = html);
  }
  setInterval(tick, 250);
  tick();

  return {
    phase,
    choose,
    choosing: () => !picker.hidden,
    closePicker,
    cast,
    press,
    reelIn,
    draw,
    confirming: () => phase() === "focus" && Date.now() < confirmUntil,
    spot: () => (state.phase === "out" ? state : null),
  };
}
