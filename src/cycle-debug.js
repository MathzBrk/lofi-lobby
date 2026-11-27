// Dev-only cycle debug panel: injected only when import.meta.env.DEV is true so production
// builds contain no debug UI, styles, or telemetry code.
import * as THREE from "three";

const DEBUG_CSS = `
  #cycle-debug-panel { left: 28px; top: 208px; width: 312px; padding: 12px 14px; font-size: 10px; line-height: 1.45; color: #C4C6D4; z-index: 4; }
  #cycle-debug-panel[hidden] { display: none; }
  #cycle-debug-panel header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  #cycle-debug-panel header b { font-weight: 400; color: #ffc95a; font-size: 11px; }
  #cycle-debug-panel .dbg-close { font: inherit; font-size: 11px; color: #C4C6D4; background: none; border: 0; padding: 0 4px; cursor: pointer; }
  #cycle-debug-panel .dbg-close:hover { color: #ffc95a; }
  .dbg-bar { position: relative; display: flex; height: 8px; border-radius: 4px; overflow: hidden; border: 1px solid rgba(255,255,255,.16); margin-bottom: 8px; }
  .dbg-bar span { height: 100%; }
  .dbg-bar .s-night { background: #1c2856; }
  .dbg-bar .s-dawn { background: #d4847a; }
  .dbg-bar .s-day { background: #64a8e8; }
  .dbg-bar .s-dusk { background: #d97b54; }
  #dbg-pin { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #fff; box-shadow: 0 0 4px #ffc95a; pointer-events: none; }
  #cycle-debug-panel dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0 0 8px; }
  #cycle-debug-panel dt { color: #9a9db0; }
  #cycle-debug-panel dd { margin: 0; color: #F2F2F5; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dbg-speeds { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .dbg-speeds span { color: #9a9db0; margin-right: 2px; }
  .dbg-speeds button { font: inherit; font-size: 9px; color: #F2F2F5; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.18); border-radius: 4px; padding: 2px 6px; cursor: pointer; }
  .dbg-speeds button:hover, .dbg-speeds button.on { border-color: #ffc95a; color: #ffc95a; }
  #dbg-reset { margin-left: auto; }
  @media (pointer: coarse) {
    #cycle-debug-panel { left: 12px; top: calc(204px + env(safe-area-inset-top)); width: auto; max-width: calc(100vw - 24px); }
  }
`;

const _dbgDir = new THREE.Vector3();
const _dbgUp = new THREE.Vector3(0, 1, 0);
const dbgLum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const fmtDur = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`);

function cycleStageInfo(p) {
  if (p < 0.15 || p >= 0.85) {
    const posInNight = p >= 0.85 ? p - 0.85 : p + 0.15;
    return { stage: "night", label: "night", progress: posInNight / 0.3, span: 0.3 };
  }
  if (p < 0.35) {
    const label = p < 0.185 ? "pre-dawn" : p < 0.26 ? "dawn" : "sunrise";
    return { stage: "dawn", label, progress: (p - 0.15) / 0.2, span: 0.2 };
  }
  if (p < 0.65) {
    return { stage: "day", label: "day", progress: (p - 0.35) / 0.3, span: 0.3 };
  }
  const label = p < 0.75 ? "golden hour" : p < 0.815 ? "sunset" : "twilight";
  return { stage: "dusk", label, progress: (p - 0.65) / 0.2, span: 0.2 };
}

/** Mounts the dev-only cycle debug toolbar button and panel, returning the per-frame updater. */
export function setupCycleDebug({
  getTimeMode,
  getCyclePhase,
  getCycleDurationMs,
  setCycleDuration,
  getLook,
  getRainAmount,
  getLampIntensity,
}) {
  const style = Object.assign(document.createElement("style"), { textContent: DEBUG_CSS });
  document.head.appendChild(style);

  const helpBtn = document.querySelector("#help");
  const hint = document.querySelector("#hint");
  const debugBtn = Object.assign(document.createElement("button"), {
    id: "cycle-debug",
    type: "button",
    innerHTML: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  });
  debugBtn.setAttribute("aria-label", "cycle debug");
  helpBtn.before(debugBtn);

  const debugPanel = Object.assign(document.createElement("div"), {
    id: "cycle-debug-panel",
    className: "glass",
    hidden: true,
    innerHTML: `
      <header><b>cycle debug</b><button id="dbg-close" class="dbg-close" type="button" aria-label="close">✕</button></header>
      <div class="dbg-bar" aria-hidden="true">
        <span class="s-night" style="width:15%"></span><span class="s-dawn" style="width:20%"></span><span class="s-day" style="width:30%"></span><span class="s-dusk" style="width:20%"></span><span class="s-night" style="width:15%"></span>
        <i id="dbg-pin"></i>
      </div>
      <dl>
        <dt>mode</dt><dd id="dbg-mode">—</dd>
        <dt>phase</dt><dd id="dbg-phase">—</dd>
        <dt>stage</dt><dd id="dbg-stage-time">—</dd>
        <dt>cycle</dt><dd id="dbg-budgets">—</dd>
        <dt>elapsed</dt><dd id="dbg-totals">—</dd>
        <dt>fps</dt><dd id="dbg-fps">—</dd>
        <dt>stalls &gt;80ms</dt><dd id="dbg-stalls">0</dd>
        <dt>static</dt><dd id="dbg-static">0.0s</dd>
        <dt>light</dt><dd id="dbg-light">—</dd>
      </dl>
      <div class="dbg-speeds">
        <span>speed:</span>
        <button type="button" data-cycle="2">2s</button>
        <button type="button" data-cycle="5">5s</button>
        <button type="button" data-cycle="10">10s</button>
        <button type="button" data-cycle="60">1m</button>
        <button type="button" data-cycle="600">10m</button>
        <button type="button" id="dbg-reset" title="reset debug counters">↺</button>
      </div>`,
  });
  hint.after(debugPanel);

  const dbgEls = {
    pin: debugPanel.querySelector("#dbg-pin"),
    mode: debugPanel.querySelector("#dbg-mode"),
    phase: debugPanel.querySelector("#dbg-phase"),
    stageTime: debugPanel.querySelector("#dbg-stage-time"),
    budgets: debugPanel.querySelector("#dbg-budgets"),
    totals: debugPanel.querySelector("#dbg-totals"),
    fps: debugPanel.querySelector("#dbg-fps"),
    stalls: debugPanel.querySelector("#dbg-stalls"),
    staticTime: debugPanel.querySelector("#dbg-static"),
    light: debugPanel.querySelector("#dbg-light"),
    speeds: [...debugPanel.querySelectorAll(".dbg-speeds button[data-cycle]")],
  };

  const dbg = {
    lastFrameMs: 0,
    lastUiMs: 0,
    fps: 60,
    avgMs: 16.7,
    stalls: 0,
    maxStallMs: 0,
    staticMs: 0,
    lastLum: -1,
    lastSunX: NaN,
    justResumed: false,
    stageMs: { night: 0, dawn: 0, day: 0, dusk: 0 },
  };

  function currentGroundLum() {
    const look = getLook();
    const t = look.daylight;
    const closed = Math.max(getRainAmount(), 1 - t);
    const gloom = 1 - (0.2 + 0.2 * t) * closed;
    _dbgDir.copy(look.sunPos).normalize();
    return (
      dbgLum(look.skyTop) * look.skyIntensity * gloom +
      dbgLum(look.sunColor) * look.sunIntensity * gloom * Math.max(0, _dbgDir.dot(_dbgUp))
    );
  }

  function resetDebugCounters() {
    dbg.stalls = 0;
    dbg.maxStallMs = 0;
    dbg.staticMs = 0;
    dbg.stageMs = { night: 0, dawn: 0, day: 0, dusk: 0 };
    dbg.lastUiMs = 0;
  }

  function drawDebugSpeeds() {
    const sec = Math.round(getCycleDurationMs() / 1000);
    for (const b of dbgEls.speeds) b.classList.toggle("on", Number(b.dataset.cycle) === sec);
  }

  function toggleCycleDebug(forceOpen) {
    const open = forceOpen ?? debugPanel.hidden;
    debugPanel.hidden = !open;
    debugBtn.classList.toggle("on", open);
    if (open) {
      hint.classList.remove("fade");
      hint.hidden = true;
      helpBtn.classList.remove("on");
      dbg.lastUiMs = 0;
      drawDebugSpeeds();
    }
  }

  drawDebugSpeeds();
  debugBtn.addEventListener("click", (e) => {
    toggleCycleDebug();
    e.currentTarget.blur();
  });
  debugPanel.querySelector("#dbg-close").addEventListener("click", (e) => {
    toggleCycleDebug(false);
    e.currentTarget.blur();
  });
  debugPanel.querySelector("#dbg-reset").addEventListener("click", (e) => {
    resetDebugCounters();
    e.currentTarget.blur();
  });
  for (const b of dbgEls.speeds) {
    b.addEventListener("click", (e) => {
      setCycleDuration(Number(b.dataset.cycle) * 1000);
      drawDebugSpeeds();
      dbg.lastUiMs = 0;
      e.currentTarget.blur();
    });
  }
  helpBtn.addEventListener("click", () => {
    if (!hint.hidden) toggleCycleDebug(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") dbg.justResumed = true;
  });

  return function updateCycleDebug() {
    const nowMs = performance.now();
    let rawDtMs = dbg.lastFrameMs ? nowMs - dbg.lastFrameMs : 0;
    dbg.lastFrameMs = nowMs;
    if (dbg.justResumed) {
      dbg.justResumed = false;
      rawDtMs = 0;
    }
    const timeMode = getTimeMode();
    const cycleDurationMs = getCycleDurationMs();
    const look = getLook();
    const p = timeMode === "auto" ? getCyclePhase() : timeMode === "day" ? 0.5 : 0;
    const info = timeMode === "auto"
      ? cycleStageInfo(p)
      : { stage: timeMode, label: `${timeMode} (fixed)`, progress: 0, span: 0.3 };
    const gndLum = currentGroundLum();
    if (rawDtMs > 0) {
      const instFps = Math.min(240, 1000 / rawDtMs);
      dbg.fps = dbg.fps * 0.9 + instFps * 0.1;
      dbg.avgMs = dbg.avgMs * 0.9 + rawDtMs * 0.1;
      if (document.visibilityState === "visible" && rawDtMs > 80) {
        dbg.stalls++;
        if (rawDtMs > dbg.maxStallMs) dbg.maxStallMs = rawDtMs;
      }
      dbg.stageMs[info.stage] += rawDtMs;
      if (Math.abs(gndLum - dbg.lastLum) < 0.0005 && Math.abs(look.sunPos.x - dbg.lastSunX) < 0.05) {
        dbg.staticMs += rawDtMs;
      } else {
        dbg.staticMs = 0;
      }
    }
    dbg.lastLum = gndLum;
    dbg.lastSunX = look.sunPos.x;
    if (debugPanel.hidden) return;
    dbgEls.pin.style.left = `calc(${(p * 100).toFixed(2)}% - 1px)`;
    if (nowMs - dbg.lastUiMs < 100) return;
    dbg.lastUiMs = nowMs;
    dbgEls.mode.textContent = timeMode === "auto" ? `auto (${fmtDur(cycleDurationMs)})` : `${timeMode} (manual)`;
    dbgEls.phase.textContent = timeMode === "auto" ? `${p.toFixed(3)} · ${info.label}` : info.label;
    dbgEls.stageTime.textContent = timeMode === "auto"
      ? `${info.stage} ${fmtDur(info.progress * info.span * cycleDurationMs)} / ${fmtDur(info.span * cycleDurationMs)}`
      : "manual hold";
    dbgEls.budgets.textContent = `D:${fmtDur(cycleDurationMs * 0.3)} N:${fmtDur(cycleDurationMs * 0.3)} T:${fmtDur(cycleDurationMs * 0.2)}`;
    dbgEls.totals.textContent = `D:${fmtDur(dbg.stageMs.day)} N:${fmtDur(dbg.stageMs.night)} R:${fmtDur(dbg.stageMs.dawn)} S:${fmtDur(dbg.stageMs.dusk)}`;
    dbgEls.fps.textContent = `${Math.round(dbg.fps)} (${dbg.avgMs.toFixed(1)}ms)`;
    dbgEls.stalls.textContent = dbg.stalls ? `${dbg.stalls} (max ${Math.round(dbg.maxStallMs)}ms)` : "0";
    dbgEls.staticTime.textContent = fmtDur(dbg.staticMs);
    dbgEls.light.textContent = `lum ${gndLum.toFixed(3)} · sun ${look.sunIntensity.toFixed(2)} · lamp ${Math.round(getLampIntensity())}`;
  };
}
