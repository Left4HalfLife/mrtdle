(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const input = $("#guess-input");
  const list = $("#suggestions");
  const form = $("#guess-form");
  const guessBtn = $("#guess-btn");
  const rowsEl = $("#rows");
  const message = $("#message");
  const giveUpBtn = $("#giveup-btn");
  const SVG_NS = "http://www.w3.org/2000/svg";
  const STATUS_EMOJI = { correct: "🟩", partial: "🟧", wrong: "🟥" };

  let data = null;          // { lines, stations, edges, attribution }
  let game = null;          // { game, date, next_in_seconds }
  let state = null;         // { guesses: [hint], status: "playing"|"won"|"lost", answer }
  let matches = [];
  let active = -1;
  let busy = false;
  const nodeEls = new Map();

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const storageKey = () => `mrtdle-game-${game.game}`;
  const guessedNames = () => new Set(state.guesses.map((g) => g.station));

  function save() {
    try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch (_) { /* private mode */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (raw) return JSON.parse(raw);
    } catch (_) { /* ignore corrupt state */ }
    return { guesses: [], status: "playing", answer: null };
  }

  async function api(path, body) {
    const res = await fetch(path, body ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    } : undefined);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Something went wrong");
    return json;
  }

  // ---------- Background map ----------
  function svg(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  }

  function drawMap() {
    const map = $("#map");
    const { stations, edges, lines } = data;
    const kx = Math.cos((1.35 * Math.PI) / 180);
    const lons = stations.map((s) => s.lon * kx);
    const lats = stations.map((s) => s.lat);
    const minX = Math.min(...lons), maxX = Math.max(...lons);
    const minY = Math.min(...lats), maxY = Math.max(...lats);
    const W = 1000, scale = W / (maxX - minX), H = (maxY - minY) * scale, pad = 50;
    const pos = stations.map((s) => [(s.lon * kx - minX) * scale, (maxY - s.lat) * scale]);

    map.setAttribute("viewBox", `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`);
    map.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const defs = svg("defs", {}, map);
    const filter = svg("filter", { id: "glow", x: "-200%", y: "-200%", width: "500%", height: "500%" }, defs);
    svg("feGaussianBlur", { stdDeviation: "3", result: "blur" }, filter);
    const merge = svg("feMerge", {}, filter);
    svg("feMergeNode", { in: "blur" }, merge);
    svg("feMergeNode", { in: "SourceGraphic" }, merge);

    const edgeLayer = svg("g", {}, map);
    for (const [a, b, line] of edges) {
      svg("line", {
        class: "edge", stroke: lines[line].color,
        x1: pos[a][0], y1: pos[a][1], x2: pos[b][0], y2: pos[b][1],
      }, edgeLayer);
    }
    const nodeLayer = svg("g", {}, map);
    stations.forEach((s, i) => {
      const g = svg("g", { "data-name": s.name }, nodeLayer);
      const [x, y] = pos[i];
      const big = s.codes.length > 1;
      svg("circle", { class: "ring", cx: x, cy: y, "data-r": big ? 5.5 : 4 }, g);
      svg("circle", { class: `node${big ? " interchange" : ""}`, cx: x, cy: y, "data-r": big ? 5.5 : 4 }, g);
      const label = svg("text", { class: "label", "data-x": x, "data-y": y }, g);
      label.textContent = s.name;
      nodeEls.set(s.name, g);
    });
    scaleMap();
    window.addEventListener("resize", scaleMap);
  }

  // Keep nodes and labels a constant on-screen size whatever the map's scale.
  function scaleMap() {
    const map = $("#map");
    const vb = map.viewBox.baseVal;
    const rect = map.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const k = Math.max(vb.width / rect.width, vb.height / rect.height);
    map.style.setProperty("--k", k);
    map.querySelectorAll("circle").forEach((c) => c.setAttribute("r", c.dataset.r * k));
    map.querySelectorAll("text").forEach((t) => {
      t.setAttribute("x", +t.dataset.x + 9 * k);
      t.setAttribute("y", +t.dataset.y + 4 * k);
    });
  }

  function lightUp(name, cls) {
    const g = nodeEls.get(name);
    if (!g) return;
    nodeEls.forEach((el) => el.classList.remove("latest"));
    g.classList.add(cls, "latest");
    g.parentNode.appendChild(g); // bring to front
  }

  // ---------- Autocomplete ----------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function highlight(name, query) {
    const i = name.toLowerCase().indexOf(query.toLowerCase());
    if (!query || i < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, i)) + "<mark>" + escapeHtml(name.slice(i, i + query.length)) +
      "</mark>" + escapeHtml(name.slice(i + query.length));
  }

  function codeBadges(codes) {
    return codes.map((c) => {
      const line = c.startsWith("CG") ? "EW" : c.slice(0, 2);
      return `<span class="code" style="background:${data.lines[line].color}">${c}</span>`;
    }).join("");
  }

  function findMatches(query) {
    const q = norm(query);
    if (!q) return [];
    const scored = [];
    for (const s of data.stations) {
      const n = norm(s.name);
      const words = s.name.toLowerCase().split(/[\s-]+/).map(norm);
      let score = -1;
      if (n.startsWith(q)) score = 0;
      else if (words.some((w) => w.startsWith(q))) score = 1;
      else if (n.includes(q)) score = 2;
      else if (s.codes.some((c) => c.toLowerCase() === q)) score = 0;
      else if (s.codes.some((c) => c.toLowerCase().startsWith(q))) score = 3;
      if (score >= 0) scored.push([score, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    return scored.map(([, s]) => s);
  }

  function renderSuggestions() {
    const used = guessedNames();
    matches = findMatches(input.value);
    active = matches.findIndex((s) => !used.has(s.name));
    list.innerHTML = "";
    matches.forEach((s, i) => {
      const li = document.createElement("li");
      li.id = `opt-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      if (used.has(s.name)) li.classList.add("used");
      li.innerHTML = `<span>${highlight(s.name, input.value.trim())}</span><span class="codes">${codeBadges(s.codes)}</span>`;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = s.name;
        closeSuggestions();
        submitGuess(s.name);
      });
      list.appendChild(li);
    });
    const open = matches.length > 0;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    updateActive();
  }

  function updateActive() {
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    if (active >= 0 && list.children[active]) {
      list.children[active].scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", `opt-${active}`);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function closeSuggestions() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  }

  input.addEventListener("input", () => { message.textContent = ""; renderSuggestions(); });
  input.addEventListener("focus", () => { if (input.value) renderSuggestions(); });
  input.addEventListener("blur", () => setTimeout(closeSuggestions, 100));
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !matches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % matches.length; updateActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; updateActive(); }
    else if (e.key === "Escape") { closeSuggestions(); }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let name = null;
    if (!list.hidden && active >= 0 && matches[active]) name = matches[active].name;
    else {
      const exact = data.stations.find((s) => norm(s.name) === norm(input.value));
      if (exact) name = exact.name;
      else if (matches.length === 1) name = matches[0].name;
    }
    closeSuggestions();
    if (!name) { message.textContent = input.value.trim() ? "Pick a station from the list." : ""; return; }
    submitGuess(name);
  });

  // ---------- Guessing ----------
  async function submitGuess(name) {
    if (busy || state.status !== "playing") return;
    if (guessedNames().has(name)) { message.textContent = `You already guessed ${name}.`; return; }
    busy = true;
    input.value = "";
    message.textContent = "";
    try {
      const hint = await api("/api/guess", { game: game.game, station: name });
      state.guesses.push(hint);
      if (hint.correct) { state.status = "won"; state.answer = hint.station; }
      save();
      addRow(hint, true);
      refreshStatus();
    } catch (err) {
      input.value = name;
      message.textContent = err.message;
    } finally {
      busy = false;
      if (state.status === "playing") input.focus();
    }
  }

  const ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
  const arrowFor = (deg) => ARROWS[Math.round(deg / 45) % 8];

  function cell(status, html) {
    const d = document.createElement("div");
    d.className = `cell ${status}`;
    d.setAttribute("role", "cell");
    d.innerHTML = html;
    return d;
  }

  function addRow(hint, animate) {
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "row");
    const nameCell = cell("name", `<span>${escapeHtml(hint.station)}</span><span class="codes">${codeBadges(hint.codes)}</span>`);
    const lines = hint.lines.value.map((l) =>
      `<span class="pill" style="border-color:${data.lines[l].color};color:${data.lines[l].color}" title="${data.lines[l].name}">${l}</span>`).join("");
    const structure = hint.structure.value.length > 1 ? "Both" : hint.structure.value[0];
    const structureSub = hint.structure.value.length > 1 ? `<span class="sub">Above &amp; underground</span>` : "";
    const d = hint.distance;
    const arrow = d.bearing === null ? "🎯" : `<span class="arrow" title="${d.bearing}°">${arrowFor(d.bearing)}</span>`;
    const stopsLabel = hint.stops.value === 1 ? "stop" : "stops";

    row.append(
      nameCell,
      cell(hint.lines.status, `<span class="pill-group">${lines}</span>`),
      cell(hint.structure.status, `<span>${structure}</span>${structureSub}`),
      cell(d.status, `<span>${d.value.toFixed(1)} km</span>${arrow}`),
      cell(hint.stops.status, `<span>${hint.stops.value}</span><span class="sub">${stopsLabel}</span>`),
    );
    if (!animate) row.classList.add("no-anim");
    rowsEl.append(row);
    lightUp(hint.station, hint.correct ? "answer" : "guessed");
  }

  // ---------- Game status ----------
  function refreshStatus() {
    const playing = state.status === "playing";
    input.disabled = !playing;
    guessBtn.disabled = !playing;
    giveUpBtn.hidden = !playing || state.guesses.length === 0;
    input.placeholder = playing ? "Type a station name or code…" : "Come back tomorrow for a new station!";
    $("#game-label").textContent = `#${game.game} · ${state.guesses.length} guess${state.guesses.length === 1 ? "" : "es"}`;

    const result = $("#result");
    if (playing) { result.hidden = true; return; }
    result.hidden = false;
    result.classList.toggle("lost", state.status === "lost");
    const n = state.guesses.length;
    if (state.status === "won") {
      $("#result-title").textContent = n === 1 ? "Hole in one! 🎉" : "You found it! 🎉";
      $("#result-text").textContent = `Today's station was ${state.answer}. Solved in ${n} guess${n === 1 ? "" : "es"}.`;
    } else {
      $("#result-title").textContent = "Better luck tomorrow";
      $("#result-text").textContent = `Today's station was ${state.answer}.`;
      lightUp(state.answer, "answer");
    }
  }

  giveUpBtn.addEventListener("click", async () => {
    if (!confirm("Give up and reveal today's station?")) return;
    try {
      const { station } = await api("/api/reveal", { game: game.game });
      state.status = "lost";
      state.answer = station;
      save();
      refreshStatus();
    } catch (err) {
      message.textContent = err.message;
    }
  });

  $("#share-btn").addEventListener("click", async () => {
    const grid = state.guesses.map((g) =>
      [g.lines, g.structure, g.distance, g.stops].map((h) => STATUS_EMOJI[h.status]).join("")).join("\n");
    const score = state.status === "won" ? `${state.guesses.length} guesses` : "X";
    const text = `MRTdle #${game.game} 🚇 ${score}\n${grid}\n${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); message.textContent = "Result copied to clipboard!"; }
    } catch (_) { /* user cancelled */ }
  });

  function startCountdown() {
    const end = Date.now() + game.next_in_seconds * 1000;
    const tick = () => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000));
      const pad = (v) => String(v).padStart(2, "0");
      $("#countdown").textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
      if (s === 0) location.reload();
    };
    tick();
    setInterval(tick, 1000);
  }

  // ---------- Help ----------
  const help = $("#help");
  $("#help-btn").addEventListener("click", () => help.showModal());

  // ---------- Init ----------
  async function init() {
    try {
      [data, game] = await Promise.all([api("/api/stations"), api("/api/today")]);
    } catch (err) {
      $("#game-label").textContent = "Offline";
      message.textContent = "Could not load the game. Please refresh.";
      return;
    }
    $("#attribution").textContent = data.attribution;
    drawMap();
    state = load();
    state.guesses.forEach((h) => addRow(h, false));
    refreshStatus();
    startCountdown();
    if (!localStorage.getItem("mrtdle-seen-help")) {
      localStorage.setItem("mrtdle-seen-help", "1");
      help.showModal();
    }
    if (state.status === "playing") input.focus();
  }

  init();
})();
