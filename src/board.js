// Message wall: a cork board in the town (3D) and the wall screen it opens (DOM).
// Notes come from /api/notes (worker/index.js keeps them forever); new and deleted
// notes arrive live on the room's WebSocket (onNote / onNoteDeleted).
import * as THREE from "three";
import "./board.css";

const COLORS = { cream: "#f4ead2", yellow: "#ffe08a", pink: "#ffc2cf", blue: "#bfe0ff", green: "#c9ecb4", lilac: "#dccbff" };
const NEAR = 5.5; // how close you need to be for the "read the wall" prompt
const MAX = 2000;
const PINS = ["#e0473e", "#3e7be0", "#e0b23e", "#3ea86a"];

// ---- 3D board ----
// same family as the houses around it: olive-brown planks, darker beams, the green of their roofs
const wood = new THREE.MeshLambertMaterial({ color: "#9a8a5a", flatShading: true });
const darkWood = new THREE.MeshLambertMaterial({ color: "#6f6342", flatShading: true });
const roofing = new THREE.MeshLambertMaterial({ color: "#1f7a5c", flatShading: true });
const cork = document.createElement("canvas");
cork.width = 96;
cork.height = 64;
const corkTex = new THREE.CanvasTexture(cork);
corkTex.magFilter = THREE.NearestFilter;
corkTex.minFilter = THREE.NearestFilter;
corkTex.colorSpace = THREE.SRGBColorSpace;

// deterministic "random" from a string, so a note always sits the same way
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function paintCork(notes) {
  const c = cork.getContext("2d");
  c.fillStyle = "#b8a274";
  c.fillRect(0, 0, 96, 64);
  for (let i = 0; i < 260; i++) {
    const h = hash("cork" + i);
    c.fillStyle = h % 3 ? "#a58f62" : "#c8b384";
    c.fillRect(h % 96, (h >> 8) % 64, 1, 1);
  }
  // the latest notes, as little papers with a pin
  const spots = [[6, 6], [30, 4], [55, 7], [76, 5], [10, 34], [36, 33], [60, 35], [80, 36]];
  notes.slice(0, spots.length).forEach((n, i) => {
    const [x, y] = spots[i];
    const h = hash(n.id);
    const w = 14 + (h % 4), ht = 18 + ((h >> 3) % 5);
    c.fillStyle = "rgba(0,0,0,.25)";
    c.fillRect(x + 1, y + 1, w, ht);
    c.fillStyle = COLORS[n.color] || COLORS.cream;
    c.fillRect(x, y, w, ht);
    c.fillStyle = "rgba(125,112,72,.1)"; // paper that has been outside for a while
    c.fillRect(x, y, w, ht);
    c.fillStyle = "rgba(60,40,30,.45)";
    for (let l = 0; l < 4; l++) c.fillRect(x + 2, y + 5 + l * 3, w - 4 - ((h >> l) % 5), 1);
    c.fillStyle = PINS[h % 4];
    c.fillRect(x + (w >> 1) - 1, y - 1, 3, 3);
  });
  corkTex.needsUpdate = true;
}
paintCork([]);

export function createBoard(scene) {
  const g = new THREE.Group();
  const box = (w, h, d, m, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  box(0.5, 6.2, 0.5, darkWood, -3.4, 3.1, 0);
  box(0.5, 6.2, 0.5, darkWood, 3.4, 3.1, 0);
  box(7.2, 4.4, 0.35, wood, 0, 3.6, 0); // frame
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 3.7),
    new THREE.MeshLambertMaterial({ map: corkTex }),
  );
  panel.position.set(0, 3.6, 0.19);
  g.add(panel);
  // a little roof keeps the rain off
  const roofL = box(4.2, 0.25, 1.6, roofing, -1.9, 6.35, 0);
  roofL.rotation.z = 0.22;
  const roofR = box(4.2, 0.25, 1.6, roofing, 1.9, 6.35, 0);
  roofR.rotation.z = -0.22;
  // no light of its own: it stands by the lamp posts
  scene.add(g);
  return g;
}

// ---- wall screen ----
const $ = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

const ago = (at) => {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
  return new Date(at).toLocaleDateString();
};
const newestFirst = (a, b) => (a.id < b.id ? 1 : -1);

export function setupWall({ getName, getGender, isAdmin }) {
  const notes = new Map(); // id -> note
  const cards = new Map(); // id -> its paper on the cork
  let more = true, loading = false, open = false, color = "cream", total = 0, columns = [];

  const root = $("div");
  root.id = "wall";
  root.hidden = true;
  root.innerHTML = `
    <div class="board" role="dialog" aria-label="message wall">
      <header>
        <b>message wall</b><small class="count"></small>
        <button class="write" type="button">+ pin a note</button>
        <button class="close" type="button" aria-label="close">✕</button>
      </header>
      <div class="cork">
        <div class="notes"></div>
        <p class="empty" hidden>the wall is empty. be the first.</p>
        <div class="more"></div>
      </div>
    </div>
    <div class="over" data-over="compose" hidden>
      <form class="compose paper">
        <i class="pin"></i>
        <textarea maxlength="${MAX}" placeholder="leave something for whoever passes by…"></textarea>
        <div class="row"><div class="colors"></div><small class="left"></small></div>
        <div class="row">
          <small class="err"></small>
          <button type="button" class="cancel">cancel</button>
          <button type="submit" class="pin-it">pin it</button>
        </div>
      </form>
    </div>
    <div class="over" data-over="zoom" hidden></div>`;
  document.body.append(root);

  const elCork = root.querySelector(".cork");
  const elNotes = root.querySelector(".notes");
  const elCount = root.querySelector(".count");
  const elEmpty = root.querySelector(".empty");
  const compose = root.querySelector("[data-over=compose]");
  const zoom = root.querySelector("[data-over=zoom]");
  const form = compose.querySelector("form");
  const area = form.querySelector("textarea");
  const left = form.querySelector(".left");
  const err = form.querySelector(".err");
  const colors = form.querySelector(".colors");
  for (const [name, hex] of Object.entries(COLORS)) {
    const b = $("button", name === color ? "on" : "");
    b.type = "button";
    b.style.background = hex;
    b.setAttribute("aria-label", name + " paper");
    b.addEventListener("click", () => {
      color = name;
      colors.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      form.dataset.color = name;
      area.focus({ preventScroll: true });
    });
    colors.append(b);
  }
  form.dataset.color = color;

  const updateLeft = () => {
    const n = MAX - area.value.length;
    left.textContent = n < 300 ? `${n} left` : "";
  };
  area.addEventListener("input", updateLeft);

  // while the wall is open every key belongs to it: no walking, no chat, no game shortcuts.
  // Esc closes one layer at a time; Cmd/Ctrl+Enter pins the note being written; E or B closes the wall
  addEventListener("keydown", (e) => {
    if (!open) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      if (!zoom.hidden) zoom.hidden = true;
      else if (!compose.hidden) compose.hidden = true;
      else close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !compose.hidden) form.requestSubmit();
    // the keys that open the wall also close it (not while writing: there they are letters)
    else if (/^[eb]$/i.test(e.key) && compose.hidden && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) close();
  }, true);

  function card(n) {
    const el = $("article", "paper");
    el.dataset.color = n.color;
    const h = hash(n.id);
    el.style.setProperty("--tilt", ((h % 7) - 3) * 0.45 + "deg");
    el.style.setProperty("--pin", PINS[h % 4]);
    const text = $("p", "text", n.text); // textContent: never HTML from a note
    const foot = $("footer");
    const time = $("time", "", ago(n.at));
    time.dataset.at = n.at;
    foot.append($("span", "who " + n.gender, n.name), time);
    el.append($("i", "pin"), text, foot);
    if (isAdmin()) {
      const del = $("button", "del", "✕");
      del.type = "button";
      del.setAttribute("aria-label", "delete note");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (del.classList.contains("confirm")) return remove(n.id);
        del.classList.add("confirm");
        del.textContent = "delete?";
        setTimeout(() => { del.classList.remove("confirm"); del.textContent = "✕"; }, 3000);
      });
      el.append(del);
    }
    // a long note is cut on the cork and opens whole on click
    el.addEventListener("click", () => {
      if (!el.classList.contains("long")) return;
      const big = el.cloneNode(true);
      big.classList.remove("long", "new");
      big.querySelector(".del")?.remove();
      zoom.replaceChildren(big);
      zoom.hidden = false;
    });
    return el;
  }

  // Masonry by hand: each note goes to the shortest column, so older notes loading in (or a new
  // one arriving) never reshuffle what you are reading, and the newest read left to right.
  const columnCount = () => Math.max(1, Math.min(4, Math.floor((elCork.clientWidth - 20) / (innerWidth < 640 ? 160 : 220))));
  const shortest = () => columns.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
  function place(n, where) {
    const el = card(n);
    cards.set(n.id, el);
    shortest()[where](el);
    el.classList.toggle("long", el.querySelector(".text").scrollHeight > el.querySelector(".text").clientHeight + 2);
    return el;
  }
  function layout() {
    columns = Array.from({ length: columnCount() }, () => $("div", "col"));
    elNotes.replaceChildren(...columns);
    cards.clear();
    [...notes.values()].sort(newestFirst).forEach((n) => place(n, "append"));
    status();
  }
  function status() {
    elEmpty.hidden = notes.size > 0 || loading;
    const n = Math.max(total, notes.size);
    elCount.textContent = n ? `${n.toLocaleString()} ${n === 1 ? "note" : "notes"}` : "";
    paintCork([...notes.values()].sort(newestFirst));
  }
  new ResizeObserver(() => open && columns.length !== columnCount() && layout()).observe(elCork);

  async function load() {
    if (loading || !more) return;
    loading = true;
    try {
      const oldest = [...notes.keys()].sort()[0];
      const r = await fetch("/api/notes" + (oldest ? "?before=" + encodeURIComponent(oldest) : ""));
      const body = await r.json();
      more = body.more;
      total = body.total;
      loading = false;
      for (const n of body.notes) {
        if (notes.has(n.id)) continue;
        notes.set(n.id, n);
        if (open) place(n, "append");
      }
    } catch {
      loading = false;
      more = false;
    }
    status();
    // a tall screen can show the whole first page: keep going until the cork is full
    if (open && more && elCork.scrollHeight <= elCork.clientHeight + 200) load();
  }
  // older notes as you scroll down
  new IntersectionObserver((e) => e[0].isIntersecting && open && load(), { root: elCork, rootMargin: "300px" })
    .observe(root.querySelector(".more"));

  async function remove(id) {
    let password = "";
    try { password = localStorage.getItem("admin-password") || ""; } catch {}
    const r = await fetch("/api/notes/" + encodeURIComponent(id), { method: "DELETE", headers: { Authorization: "Bearer " + password } });
    if (r.ok) onNoteDeleted(id);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = area.value.trim();
    if (!text) return area.focus({ preventScroll: true });
    err.textContent = "";
    form.classList.add("busy");
    try {
      const r = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, color, name: getName(), gender: getGender() }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "could not pin it, try again");
      area.value = "";
      updateLeft();
      compose.hidden = true;
      onNote(body.note, body.total);
      elCork.scrollTop = 0;
    } catch (x) {
      err.textContent = x.message;
    }
    form.classList.remove("busy");
  });
  root.querySelector(".write").addEventListener("click", () => {
    err.textContent = "";
    compose.hidden = false;
    area.focus({ preventScroll: true });
  });
  form.querySelector(".cancel").addEventListener("click", () => (compose.hidden = true));
  root.querySelector(".close").addEventListener("click", () => close());
  // a click outside closes that layer (a note being written is kept for next time)
  root.addEventListener("click", (e) => e.target === root && close());
  compose.addEventListener("click", (e) => e.target === compose && (compose.hidden = true));
  zoom.addEventListener("click", () => (zoom.hidden = true));

  function show() {
    if (open) return;
    open = true;
    root.hidden = false;
    document.activeElement?.blur?.();
    layout(); // also refreshes every "x min ago"
    if (!notes.size || (more && elCork.scrollHeight <= elCork.clientHeight + 200)) load();
  }
  function close() {
    open = false;
    root.hidden = true;
    zoom.hidden = true;
    compose.hidden = true;
  }

  // live, from the room's WebSocket (and our own note, from the POST: whichever comes first)
  function onNote(n, count) {
    if (count) total = count;
    if (!notes.has(n.id)) {
      notes.set(n.id, n);
      if (open) place(n, "prepend").classList.add("new");
    }
    status();
  }
  function onNoteDeleted(id, count) {
    if (count != null) total = count;
    else if (notes.has(id)) total = Math.max(0, total - 1);
    notes.delete(id);
    cards.get(id)?.remove();
    cards.delete(id);
    status();
  }

  load(); // the board in town shows the latest notes
  return { show, close, isOpen: () => open, onNote, onNoteDeleted, NEAR };
}
