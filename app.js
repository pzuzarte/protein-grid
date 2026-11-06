"use strict";

const PPQ = Music.PPQ;
const BAR = PPQ * 4;
const SLOTS = 16;
const SCHEDULE_AHEAD_MS = 150;
const CHUNK_PULSES = 10; // Must divide CLOCK_PULSES.
const CLOCK_PULSES = PPQ / 24;
const VELOCITY_STEPS = [1.0, 0.7, 0.4];
const DRAG_THRESHOLD_PX = 4; // A press that moves less than this counts as a click.
const FINE_DIVISIONS = 8; // Resizing moves in eighths of a step, or quarters when steps are narrow.
const NARROW_STEP_PX = 32;
const MIN_CELL_PX = 14; // Below this, steps are too small to click reliably.
const DENSE_CELL_PX = 22;
const DEFAULT_CHANNEL = 0; // Channel 1.
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;
const STORE_KEY = "protein-grid";

const $ = (id) => document.getElementById(id);

const state = {
  root: 0,
  scale: "minor",
  moveNotes: true,
  slots: Array.from({ length: SLOTS }, () => ({ bars: 4, notes: [] })),
  current: 0,
  queued: null,
  bpm: 120,
  channel: DEFAULT_CHANNEL,
  chord: "note",
  newLength: "step",
  lowOctave: 3,
  span: 2,
  showAll: false,
  baseResolution: 240,
  triplets: false,
  resolution: 240,
  view: "grid",
  sounds: [],
  values: {},
  mappings: {},
  mapping: null,
  reading: null,
  dump: null,
  teach: null,
  readMap: null,
  page: 0,
  pageBars: 1,
  windowStart: 0,
  windowSpan: 0,
  undo: [],
  chain: "",
  chainOn: false,
  chainPos: 0,
  showLane: false,
  laneParam: "filter.cutoff",
  laneDraw: null,
  selection: null,
  selecting: null,
  clipboard: null,
  varyOriginal: null,
  varyLatest: null,
  editor: null,
  paint: null,
  lengthDrag: null,
  barsQueued: false,
  midi: null,
  output: null,
  input: null,
  playing: false,
  nextPulse: 0,
  nextTime: 0,
  saveTimer: null,
};

const slot = () => state.slots[state.current];
const lengthPulses = (item = slot()) => item.bars * BAR;
const notes = () => slot().notes;
const lowNote = () => (state.lowOctave + 1) * 12;

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", isError);
}

/* ---------- Saving in this browser ---------- */

function saveSoon() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    const saved = {};
    for (const key of ["root", "scale", "moveNotes", "slots", "current", "bpm", "channel", "chord",
      "newLength", "lowOctave", "span", "showAll", "baseResolution", "triplets", "view", "sounds", "mappings",
      "chain", "chainOn", "showLane", "laneParam", "readMap"]) {
      saved[key] = state[key];
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (error) {
      setStatus("Couldn't save in this browser. Export your patterns to keep them.", true);
    }
  }, 300);
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && Array.isArray(saved.slots) && saved.slots.length === SLOTS) {
      Object.assign(state, saved);
      state.resolution = state.triplets ? (state.baseResolution * 2) / 3 : state.baseResolution;
    }
  } catch (error) {
    // A missing or unreadable save just means starting fresh.
  }
}

/* ---------- Key ---------- */

function setKey(root, scale) {
  if (root === state.root && scale === state.scale) return;
  closeNoteEditor({ restoreFocus: false });
  remember();
  if (state.moveNotes) {
    for (const item of state.slots) {
      item.notes = Music.mapNotes(item.notes, state.root, state.scale, root, scale);
    }
  }
  state.root = root;
  state.scale = scale;
  renderAll();
  saveSoon();
  const name = `${Music.NOTE_NAMES[root]} ${Music.SCALES[scale].name.toLowerCase()}`;
  setStatus(state.moveNotes ? `Key: ${name}. Patterns moved to the new key.` : `Key: ${name}. Notes weren't moved.`);
}

function renderKey() {
  $("roots").replaceChildren(...Music.NOTE_NAMES.map((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.setAttribute("aria-pressed", String(index === state.root));
    button.addEventListener("click", () => setKey(index, state.scale));
    return button;
  }));
  $("scale").value = state.scale;
  $("move-notes").checked = state.moveNotes;
}

// Rows from high to low. Notes already in the pattern are never hidden.
function rowNotes() {
  const low = lowNote();
  const high = low + state.span * 12;
  const rows = new Set(state.showAll
    ? Array.from({ length: high - low + 1 }, (_, i) => low + i)
    : Music.notesInKey(state.root, state.scale, low, high));
  for (const item of notes()) rows.add(item.note);
  return [...rows].sort((a, b) => b - a);
}

/* ---------- Patterns ---------- */

function renderSlots() {
  const nodes = [];
  for (let index = 0; index < SLOTS; index += 1) {
    const count = state.slots[index].notes.length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot";
    button.textContent = String(index + 1);
    button.classList.toggle("has-pattern", count > 0);
    button.classList.toggle("queued", index === state.queued);
    button.setAttribute("aria-current", String(index === state.current));
    button.setAttribute("aria-label", `Pattern ${index + 1}, ${count ? `${count} notes` : "empty"}`);
    button.addEventListener("click", () => selectSlot(index));
    nodes.push(button);
  }
  $("slots").replaceChildren(...nodes);
}

function selectSlot(index) {
  if (index === state.current) {
    state.queued = null;
    renderSlots();
  } else if (state.playing) {
    state.queued = index;
    renderSlots();
    setStatus(`Pattern ${index + 1} starts at the end of this loop.`);
  } else {
    switchTo(index);
  }
}

// The sound stays as it is, so only loading a patch or a saved sound changes it.
function switchTo(index) {
  restoreAfterMotions();
  state.current = index;
  state.queued = null;
  state.page = 0;
  renderAll();
  saveSoon();
}

function duplicatePattern() {
  const target = state.slots.findIndex((item) => !item.notes.length);
  if (target < 0) {
    setStatus("All 16 patterns are in use. Clear one first.", true);
    return;
  }
  stop();
  remember();
  state.slots[target] = JSON.parse(JSON.stringify(slot()));
  switchTo(target);
  setStatus(`Copied to pattern ${target + 1}.`);
}

function generatePattern() {
  remember();
  const kind = $("generator").value;
  const low = kind === "bassline" ? lowNote() : lowNote() + 12;
  slot().notes = Music.generate(kind, {
    root: state.root, scale: state.scale, low, lengthTicks: lengthPulses(),
  });
  renderGrid();
  renderChrome();
  saveSoon();
  const hint = kind === "chords" ? " Set Polyphony to Poly on the VOICE tab to hear full chords." : "";
  setStatus(`New ${Music.GENERATORS[kind].toLowerCase()} in the key. Generate again for another, or Undo.${hint}`);
}

function shiftOctave(octaves) {
  if (!notes().length) {
    setStatus("This pattern has no notes to move.", true);
    return;
  }
  const moved = Music.shiftOctaves(notes(), octaves);
  if (!moved) {
    setStatus(`Can't move ${octaves > 0 ? "up" : "down"} an octave, as the notes would go past the MIDI range.`, true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  slot().notes = moved;
  // The view only follows once the notes leave it.
  const pitches = moved.map((n) => n.note);
  if (Math.min(...pitches) < lowNote() || Math.max(...pitches) > lowNote() + state.span * 12) {
    state.lowOctave = Math.max(1, Math.min(6, state.lowOctave + octaves));
    $("octave").value = String(state.lowOctave);
  }
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${octaves > 0 ? "up" : "down"} an octave.`);
}

function shiftInScale(steps) {
  if (!notes().length) {
    setStatus("This pattern has no notes to move.", true);
    return;
  }
  const moved = Music.shiftInScale(notes(), steps, state.root, state.scale);
  if (!moved) {
    setStatus("Can't move further, as the notes would go past the MIDI range.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  slot().notes = moved;
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${steps > 0 ? "up" : "down"} a step in the scale.`);
}

// Moves the whole pattern a step in time, wrapping around, along with its knob movements.
function shiftInTime(direction) {
  const lanes = lanesFor();
  if (!notes().length && !(lanes && Object.keys(lanes).length)) {
    setStatus("This pattern is empty.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  const by = direction * state.resolution;
  const length = lengthPulses();
  slot().notes = Music.rotateNotes(notes(), by, length);
  if (lanes && Object.keys(lanes).length) {
    for (const [cc, points] of Object.entries(editableLanes())) {
      slot().lanes[cc] = points.map((point) => ({
        ...point,
        time: (Math.round((((point.time + by) % length + length) % length) / MOTION_TICKS) * MOTION_TICKS) % length,
      })).sort((a, b) => a.time - b.time);
    }
  }
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${direction > 0 ? "later" : "earlier"} by one step.`);
}

/* ---------- Selecting steps, copy and paste ---------- */

function updateSelectionMarks() {
  const range = state.selection;
  document.querySelectorAll(".cell, .step-number[data-time]").forEach((node) => {
    const time = Number(node.dataset.time);
    node.classList.toggle("selected", Boolean(range) && time >= range.start && time < range.end);
  });
}

function selectSteps(from, to) {
  const start = Math.min(from, to);
  state.selection = { start, end: Math.max(from, to) + state.resolution };
  updateSelectionMarks();
}

function clearSelection() {
  state.selection = null;
  updateSelectionMarks();
}

function copySelection() {
  const range = state.selection;
  if (!range) {
    setStatus("Click or drag along the step numbers above the grid to choose steps first.", true);
    return;
  }
  const copied = notes().filter((n) => n.time >= range.start && n.time < range.end);
  state.clipboard = { span: range.end - range.start, notes: copied.map((n) => ({ ...n, time: n.time - range.start })) };
  $("paste").disabled = false;
  setStatus(`Copied ${copied.length} ${copied.length === 1 ? "note" : "notes"}. Choose where it goes with the step numbers, then click Paste.`);
}

// Replaces what's in the steps it lands on, in this pattern or another.
function pasteClipboard() {
  if (!state.clipboard) return;
  if (!state.selection) {
    setStatus("Click a step number to choose where to paste.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  const { start } = state.selection;
  const length = lengthPulses();
  const end = Math.min(start + state.clipboard.span, length);
  const pasted = state.clipboard.notes
    .map((n) => ({ ...n, time: n.time + start }))
    .filter((n) => n.time < length)
    .map((n) => ({ ...n, length: Math.min(n.length, length - n.time) }));
  slot().notes = [...notes().filter((n) => n.time < start || n.time >= end), ...pasted]
    .sort((a, b) => a.time - b.time || a.note - b.note);
  state.selection = { start, end };
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Pasted ${pasted.length} ${pasted.length === 1 ? "note" : "notes"}. Undo takes it back.`);
}

// Sets velocity on the chosen steps, or the whole pattern if none are chosen.
function setBulkVelocity() {
  const value = Number($("bulk-velocity").value);
  if (!Number.isInteger(value) || value < 1 || value > 127) {
    setStatus("Velocity goes from 1 to 127.", true);
    return;
  }
  const range = state.selection;
  const targets = range ? notes().filter((n) => n.time >= range.start && n.time < range.end) : notes();
  if (!targets.length) {
    setStatus(range ? "There are no notes in the chosen steps." : "This pattern has no notes.", true);
    return;
  }
  remember();
  targets.forEach((n) => { n.velocity = value / 127; });
  document.querySelectorAll(".cell").forEach(paintCell);
  renderChrome();
  saveSoon();
  setStatus(`Set ${targets.length} ${targets.length === 1 ? "note" : "notes"} to velocity ${value}.`);
}

/* ---------- Undo ---------- */

function remember() {
  state.undo.push({
    json: JSON.stringify({ root: state.root, scale: state.scale, slots: state.slots, current: state.current, bpm: state.bpm }),
  });
  if (state.undo.length > 100) state.undo.shift();
  $("undo").disabled = false;
}

function undo() {
  const last = state.undo.pop();
  if (!last) return;
  closeNoteEditor({ restoreFocus: false });
  Object.assign(state, JSON.parse(last.json));
  renderAll();
  if (state.playing) announceTempo();
  saveSoon();
}

/* ---------- Rendering the grid ---------- */

function gridWidthForSteps() {
  const wrap = $("grid-wrap");
  const style = getComputedStyle(wrap);
  const label = document.querySelector(".note-label");
  return wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    - (label ? label.offsetWidth : 76);
}

// Everything fits on one page, until steps would be too small to click.
function updatePaging() {
  const totalBars = Math.ceil(slot().bars);
  const stepsPerBar = BAR / state.resolution;
  const available = gridWidthForSteps();
  let pageBars = totalBars;
  while (pageBars > 1 && available / (pageBars * stepsPerBar) < MIN_CELL_PX) {
    pageBars = Math.ceil(pageBars / 2);
  }
  state.pageBars = pageBars;
  const pages = Math.ceil(totalBars / pageBars);
  state.page = Math.min(state.page, pages - 1);
  $("pager").hidden = pages <= 1;
  const first = state.page * pageBars + 1;
  const last = Math.min(first + pageBars - 1, totalBars);
  $("page-label").textContent = first === last
    ? `Bar ${first} of ${totalBars}` : `Bars ${first}-${last} of ${totalBars}`;
  $("page-prev").disabled = state.page === 0;
  $("page-next").disabled = state.page >= pages - 1;
}

function goToPage(page) {
  state.page = page;
  renderGrid();
}

function renderGrid() {
  closeNoteEditor({ restoreFocus: false });
  const grid = $("grid");
  updatePaging();
  const windowStart = state.page * state.pageBars * BAR;
  const windowEnd = Math.min(windowStart + state.pageBars * BAR, lengthPulses());
  const stepCount = Math.ceil((windowEnd - windowStart) / state.resolution);
  state.windowStart = windowStart;
  state.windowSpan = stepCount * state.resolution;
  const rows = rowNotes();
  grid.style.gridTemplateColumns = `var(--label-width) repeat(${stepCount}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `20px repeat(${rows.length}, minmax(14px, 1fr))`;
  const dense = gridWidthForSteps() / stepCount < DENSE_CELL_PX;
  grid.classList.toggle("dense", dense);
  grid.style.setProperty("--grid-gap", dense ? "1px" : "2px");

  const nodes = [];
  const corner = document.createElement("div");
  corner.className = "corner";
  nodes.push(corner);
  for (let step = 0; step < stepCount; step += 1) {
    const time = windowStart + step * state.resolution;
    const label = document.createElement("div");
    label.className = "step-number";
    label.dataset.time = String(time);
    label.title = "Click or drag to choose steps for Copy, Paste and Velocity";
    if (time % BAR === 0) {
      label.classList.add("bar-start");
      label.textContent = String(time / BAR + 1);
    } else if (time % PPQ === 0) {
      label.textContent = String((time % BAR) / PPQ + 1);
    }
    nodes.push(label);
  }

  for (const note of rows) {
    const isRoot = (note - state.root) % 12 === 0;
    const label = document.createElement("button");
    label.type = "button";
    label.className = "note-label";
    label.textContent = Music.noteName(note);
    label.classList.toggle("root", isRoot);
    const fits = Music.inKey(note, state.root, state.scale);
    label.classList.toggle("out-of-key", !fits);
    label.title = fits ? `Note ${note}. Click to hear it.` : `Note ${note}, outside the key. Click to hear it.`;
    label.addEventListener("pointerdown", () => audition([note]));
    nodes.push(label);
    for (let step = 0; step < stepCount; step += 1) {
      const time = windowStart + step * state.resolution;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.note = String(note);
      cell.dataset.time = String(time);
      if (Math.floor(time / PPQ) % 2 === 0) cell.classList.add("beat");
      if (time % BAR === 0) cell.classList.add("bar-start");
      if (isRoot) cell.classList.add("root-row");
      nodes.push(cell);
    }
  }
  grid.replaceChildren(...nodes);
  document.querySelectorAll(".cell").forEach(paintCell);
  renderNoteBars();
  updateSelectionMarks();
  renderLane();
}

function notesInCell(note, time) {
  return notes().filter((n) => n.note === note && n.time >= time && n.time < time + state.resolution);
}

const cellElement = (note, time) =>
  document.querySelector(`.cell[data-note="${note}"][data-time="${time}"]`);

function paintCell(cell) {
  const time = Number(cell.dataset.time);
  const note = Number(cell.dataset.note);
  const found = notesInCell(note, time);
  const on = found.length > 0;
  queueNoteBars();
  cell.classList.toggle("on", on);
  cell.classList.toggle("chance", found.some((n) => (n.probability ?? 100) < 100));
  cell.setAttribute("aria-pressed", String(on));
  cell.setAttribute("aria-label", `${Music.noteName(note)}, pulse ${time}${on ? ", on" : ""}`);
  if (on) {
    const loudest = Math.max(...found.map((n) => n.velocity));
    cell.style.setProperty("--velocity", String(0.3 + 0.7 * loudest));
  } else {
    cell.style.removeProperty("--velocity");
  }
}

function queueNoteBars() {
  if (state.barsQueued) return;
  state.barsQueued = true;
  requestAnimationFrame(() => {
    state.barsQueued = false;
    renderNoteBars();
  });
}

function renderNoteBars() {
  document.querySelectorAll(".note-bar").forEach((bar) => bar.remove());
  document.querySelectorAll(".cell.has-bar").forEach((cell) => cell.classList.remove("has-bar"));
  const start = state.windowStart;
  const end = start + state.windowSpan;
  for (const note of notes()) {
    const noteEnd = note.time + note.length;
    if (noteEnd <= start || note.time >= end) continue;
    const cellTime = Math.floor(note.time / state.resolution) * state.resolution;
    const anchorTime = Math.max(cellTime, start);
    const cell = cellElement(note.note, anchorTime);
    if (!cell) continue;
    const barStart = Math.max(note.time, start);
    const barEnd = Math.min(noteEnd, end);
    const steps = (barEnd - barStart) / state.resolution;
    const bar = document.createElement("span");
    bar.className = "note-bar";
    bar.style.setProperty("--steps", String(steps));
    bar.style.setProperty("--gaps", String(Math.max(0, Math.ceil(steps) - 1)));
    bar.style.left = `${((barStart - anchorTime) / state.resolution) * 100}%`;
    bar.style.setProperty("--velocity", String(0.3 + 0.7 * note.velocity));
    if (note.substep && note.time === barStart) {
      const mark = document.createElement("span");
      mark.className = "note-sub";
      mark.textContent = Music.SUB_STEPS[note.substep];
      bar.classList.add("sub");
      bar.append(mark);
    }
    // A note running past this page can't be resized from here.
    if (noteEnd <= end) {
      const handle = document.createElement("span");
      handle.className = "note-handle";
      handle.title = "Drag to change where this note ends. Hold Alt for finer control.";
      bar.append(handle);
    }
    cell.append(bar);
    if (note.time === barStart) cell.classList.add("has-bar");
  }
}

function renderStepControls() {
  for (const button of $("steps").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.value) === state.baseResolution));
  }
  $("triplets").setAttribute("aria-pressed", String(state.triplets));
  for (const button of $("chords").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === state.chord));
  }
}

function renderChrome() {
  $("undo").disabled = state.undo.length === 0;
  renderSlots();
}

// Imported or restored patterns can be any number of steps, such as 6 or 12.
function renderBarsOptions() {
  const select = $("bars");
  const value = String(slot().bars);
  select.querySelector("[data-custom]")?.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const option = new Option(`${slot().bars * 16} steps`, value);
    option.dataset.custom = "true";
    select.append(option);
  }
  select.value = value;
}

function renderAll() {
  renderKey();
  renderStepControls();
  renderBarsOptions();
  $("bpm").value = state.bpm;
  $("new-length").value = state.newLength;
  $("octave").value = String(state.lowOctave);
  $("span").value = String(state.span);
  $("show-all").checked = state.showAll;
  $("channel").value = String(state.channel + 1);
  renderGrid();
  renderChrome();
}

/* ---------- Editing ---------- */

function setSteps(baseResolution, triplets) {
  state.baseResolution = baseResolution;
  state.triplets = triplets;
  state.resolution = triplets ? (baseResolution * 2) / 3 : baseResolution;
  renderStepControls();
  renderGrid();
  saveSoon();
}

function setBars(bars) {
  remember();
  slot().bars = bars;
  const length = lengthPulses();
  slot().notes = notes()
    .filter((n) => n.time < length)
    .map((n) => ({ ...n, length: Math.min(n.length, length - n.time) }));
  if (slot().lanes) {
    for (const [cc, points] of Object.entries(slot().lanes)) slot().lanes[cc] = points.filter((point) => point.time < length);
  }
  if (state.nextPulse >= length) state.nextPulse = 0;
  renderGrid();
  renderChrome();
  saveSoon();
}

function newNoteLength(time) {
  const lengths = { step: state.resolution, beat: PPQ, bar: BAR };
  return Math.min(lengths[state.newLength], lengthPulses() - time);
}

// Adds the note, or the chord built on it, and returns what was added.
function addNotes(note, time) {
  const added = [];
  for (const value of Music.chordNotes(note, state.chord, state.root, state.scale)) {
    if (notesInCell(value, time).length) continue;
    const item = { time, note: value, velocity: 1, length: newNoteLength(time), probability: 100 };
    notes().push(item);
    added.push(item);
  }
  notes().sort((a, b) => a.time - b.time || a.note - b.note);
  return added;
}

function repaintFor(items) {
  for (const item of items) {
    const time = Math.floor(item.time / state.resolution) * state.resolution;
    const cell = cellElement(item.note, time);
    if (cell) paintCell(cell);
  }
}

function needsRowsFor(items) {
  return items.some((item) => !cellElement(item.note, state.windowStart));
}

function describeLength(length) {
  const steps = length / state.resolution;
  const shown = Number.isInteger(steps) ? String(steps) : steps.toFixed(2);
  return `${shown} ${steps === 1 ? "step" : "steps"}`;
}

function cycleVelocity(cell) {
  const found = notesInCell(Number(cell.dataset.note), Number(cell.dataset.time));
  if (!found.length) return;
  remember();
  const current = VELOCITY_STEPS.findIndex((v) => found[0].velocity >= v - 0.001);
  const next = VELOCITY_STEPS[(Math.max(current, 0) + 1) % VELOCITY_STEPS.length];
  found.forEach((n) => { n.velocity = next; });
  paintCell(cell);
  renderChrome();
  saveSoon();
  setStatus(`Velocity ${Math.round(next * 127)} of 127.`);
}

function startLengthDrag(event, handle) {
  const cell = handle.closest(".cell");
  const note = Number(cell.dataset.note);
  const anchorTime = Number(cell.dataset.time);
  const found = notes().find((n) => n.note === note
    && n.time < anchorTime + state.resolution && n.time + n.length > anchorTime);
  if (!found) return;
  remember();
  state.lengthDrag = { items: [found], anchorTime, cell, pressed: true, startX: event.clientX };
  event.preventDefault();
}

// Where a resize ends. Drawing a new note uses whole steps, while resizing is finer so
// a note can end inside a step. Alt gives single ticks.
function dragEnd(event, drag, start, currentLength, box) {
  const gap = parseFloat(getComputedStyle($("grid")).getPropertyValue("--grid-gap")) || 0;
  const ticksAt = (x) => drag.anchorTime + ((x - box.left) / (box.width + gap)) * state.resolution;
  // Follows the mouse from where the note was grabbed, so it doesn't jump at the start.
  if (!drag.drawing && drag.grabOffset === undefined) {
    drag.grabOffset = start + currentLength - ticksAt(drag.startX);
  }
  const pointer = ticksAt(event.clientX) + (drag.grabOffset || 0);
  if (event.altKey) return { end: Math.round(pointer), shortest: start + 1 };
  const divisions = box.width < NARROW_STEP_PX ? FINE_DIVISIONS / 2 : FINE_DIVISIONS;
  const unit = drag.drawing ? state.resolution : state.resolution / divisions;
  return {
    end: Math.round(pointer / unit) * unit,
    shortest: Math.floor(start / unit) * unit + unit,
  };
}

function moveLengthDrag(event) {
  const drag = state.lengthDrag;
  const box = drag.cell.getBoundingClientRect();
  // A click that stays on its step keeps the Length setting.
  if (drag.drawing && !drag.moved) {
    if (event.clientX <= box.right) return;
    drag.moved = true;
  }
  if (drag.pressed && !drag.moved) {
    if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
  }
  const start = drag.items[0].time;
  const target = dragEnd(event, drag, start, drag.items[0].length, box);
  const end = Math.max(target.shortest, Math.min(target.end, state.windowStart + state.windowSpan, lengthPulses()));
  const length = end - start;
  if (length !== drag.items[0].length) {
    drag.items.forEach((item) => { item.length = length; });
    renderNoteBars();
  }
  setStatus(`Length: ${describeLength(length)} (${length} ticks).`);
}

function bindGridEvents() {
  const grid = $("grid");
  grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cell = event.target.closest(".cell");
    if (cell) openNoteEditor(cell);
  });
  window.addEventListener("pointermove", (event) => {
    if (state.lengthDrag) moveLengthDrag(event);
  });
  grid.addEventListener("pointerdown", (event) => {
    const number = event.target.closest(".step-number");
    if (number && event.button === 0) {
      const time = Number(number.dataset.time);
      const range = state.selection;
      // A click on the only chosen step clears it.
      if (range && range.start === time && range.end === time + state.resolution) {
        clearSelection();
      } else {
        state.selecting = time;
        selectSteps(time, time);
      }
      event.preventDefault();
      return;
    }
    const handle = event.target.closest(".note-handle");
    if (handle && event.button === 0 && !event.ctrlKey) {
      if (state.editor) closeNoteEditor({ restoreFocus: false });
      startLengthDrag(event, handle);
      return;
    }
    const cell = event.target.closest(".cell");
    // Control-click is a right-click on a Mac and opens the editor instead.
    if (!cell || event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    if (state.editor) {
      closeNoteEditor({ restoreFocus: false });
      return;
    }
    if (event.shiftKey) {
      cycleVelocity(cell);
      return;
    }
    remember();
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    const on = !cell.classList.contains("on");
    if (on) {
      const added = addNotes(note, time);
      if (needsRowsFor(added)) {
        // A chord can reach above the rows shown, which adds rows to the grid.
        renderGrid();
      } else {
        repaintFor(added);
      }
      audition(added.map((item) => item.note));
      // Dragging draws one note at the dragged length. Cmd-drag fills separate steps.
      if (!event.metaKey && added.length) {
        state.lengthDrag = { items: added, anchorTime: time, cell: cellElement(note, time), drawing: true };
      } else {
        state.paint = { on: true };
      }
    } else if (event.metaKey) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
      paintCell(cell);
      state.paint = { on: false };
    } else {
      // Dragging a note resizes it, so it's only removed by a click that doesn't move.
      state.lengthDrag = {
        items: notesInCell(note, time), anchorTime: time, cell, pressed: true, startX: event.clientX,
      };
    }
    renderChrome();
    saveSoon();
  });
  grid.addEventListener("pointerover", (event) => {
    if (state.selecting !== null) {
      const over = event.target.closest(".step-number, .cell");
      if (over) selectSteps(state.selecting, Number(over.dataset.time));
      return;
    }
    const cell = event.target.closest(".cell");
    if (!cell || !state.paint) return;
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    if (state.paint.on && !notesInCell(note, time).length) {
      repaintFor(addNotes(note, time));
    } else if (!state.paint.on && notesInCell(note, time).length) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
    }
    paintCell(cell);
    renderChrome();
  });
  window.addEventListener("pointerup", () => {
    state.selecting = null;
    const drag = state.lengthDrag;
    if (drag && drag.pressed && !drag.moved) {
      slot().notes = notes().filter((n) => !drag.items.includes(n));
      paintCell(drag.cell);
      renderChrome();
    }
    if (state.lengthDrag || state.paint) saveSoon();
    state.lengthDrag = null;
    state.paint = null;
  });
  // Keyboard activation: pointer clicks are already handled on pointerdown.
  grid.addEventListener("click", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell || event.detail !== 0) return;
    remember();
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    if (cell.classList.contains("on")) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
      paintCell(cell);
    } else {
      repaintFor(addNotes(note, time));
    }
    renderChrome();
    saveSoon();
  });
}

/* ---------- Step editor ---------- */

const editorNotes = () => notesInCell(state.editor.note, state.editor.time);

function openNoteEditor(cell) {
  closeNoteEditor({ restoreFocus: false });
  const note = Number(cell.dataset.note);
  const time = Number(cell.dataset.time);
  let remembered = false;
  if (!notesInCell(note, time).length) {
    remember();
    remembered = true;
    const wasChord = state.chord;
    state.chord = "note";
    addNotes(note, time);
    state.chord = wasChord;
    renderChrome();
  }
  state.editor = { note, time, remembered };
  cell.classList.add("editing");
  paintCell(cell);
  const bar = Math.floor(time / BAR) + 1;
  const beat = ((time % BAR) / PPQ + 1).toFixed(2).replace(/\.?0+$/, "");
  $("editor-title").textContent = `${Music.noteName(note)}, bar ${bar}, beat ${beat}`;
  fillNoteEditor();
  const panel = $("note-editor");
  panel.hidden = false;
  const box = cell.getBoundingClientRect();
  const margin = 8;
  const fitsRight = box.right + margin + panel.offsetWidth < innerWidth;
  const left = fitsRight ? box.right + margin : box.left - panel.offsetWidth - margin;
  const top = Math.min(box.top, innerHeight - panel.offsetHeight - margin);
  panel.style.left = `${Math.max(margin, left)}px`;
  panel.style.top = `${Math.max(margin, top)}px`;
  $("edit-velocity").focus();
  $("edit-velocity").select();
}

function maxEditorOffset(found) {
  const times = found.map((n) => n.time);
  return state.resolution - 1 - (Math.max(...times) - Math.min(...times));
}

function fillNoteEditor() {
  const found = editorNotes();
  const [first] = found;
  const velocity = Math.max(1, Math.min(127, Math.round(first.velocity * 127)));
  const count = $("editor-count");
  count.hidden = found.length < 2;
  count.textContent = `Changes apply to all ${found.length} notes in this step.`;
  $("edit-velocity").value = velocity;
  $("edit-velocity-range").value = velocity;
  $("edit-length").value = first.length;
  $("edit-length").max = lengthPulses();
  $("edit-length-steps").textContent = `ticks, ${describeLength(first.length)}`;
  const maxOffset = maxEditorOffset(found);
  $("edit-offset").value = Math.min(...found.map((n) => n.time)) - state.editor.time;
  $("edit-offset").max = maxOffset;
  $("edit-offset-range").textContent = `ticks, 0-${maxOffset}`;
  $("edit-probability").value = first.probability ?? 100;
  $("edit-substep").value = String(first.substep || 0);
  for (const id of ["edit-velocity", "edit-length", "edit-offset", "edit-probability"]) {
    $(id).setAttribute("aria-invalid", "false");
  }
}

function changeEditorNotes(change) {
  if (!state.editor.remembered) {
    remember();
    state.editor.remembered = true;
  }
  change(editorNotes());
  notes().sort((a, b) => a.time - b.time || a.note - b.note);
  const cell = cellElement(state.editor.note, state.editor.time);
  if (cell) paintCell(cell);
  renderChrome();
  saveSoon();
}

// Applies a typed value if it's valid, and otherwise leaves the notes alone.
function editorNumber(id, low, high, apply) {
  const input = $(id);
  const value = Number(input.value);
  const valid = input.value !== "" && Number.isInteger(value) && value >= low && value <= high;
  input.setAttribute("aria-invalid", String(!valid));
  if (valid) apply(value);
}

function setEditorVelocity(value) {
  changeEditorNotes((found) => found.forEach((n) => { n.velocity = value / 127; }));
}

function bindNoteEditor() {
  $("edit-velocity").addEventListener("input", () => {
    editorNumber("edit-velocity", 1, 127, (value) => {
      $("edit-velocity-range").value = value;
      setEditorVelocity(value);
    });
  });
  $("edit-velocity-range").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    $("edit-velocity").value = value;
    $("edit-velocity").setAttribute("aria-invalid", "false");
    setEditorVelocity(value);
  });
  $("edit-length").addEventListener("input", () => {
    editorNumber("edit-length", 1, lengthPulses(), (value) => {
      changeEditorNotes((found) => found.forEach((n) => {
        n.length = Math.min(value, lengthPulses() - n.time);
      }));
      $("edit-length-steps").textContent = `ticks, ${describeLength(value)}`;
    });
  });
  $("edit-offset").addEventListener("input", () => {
    editorNumber("edit-offset", 0, maxEditorOffset(editorNotes()), (value) => {
      changeEditorNotes((found) => {
        const start = Math.min(...found.map((n) => n.time));
        const delta = state.editor.time + value - start;
        found.forEach((n) => { n.time += delta; });
      });
    });
  });
  $("edit-probability").addEventListener("input", () => {
    editorNumber("edit-probability", 0, 100, (value) => {
      changeEditorNotes((found) => found.forEach((n) => { n.probability = value; }));
    });
  });
  $("edit-substep").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    changeEditorNotes((found) => found.forEach((n) => {
      if (value) n.substep = value;
      else delete n.substep;
    }));
    renderNoteBars();
  });
  // Leaving a field with a bad value puts back the value actually in use.
  $("note-editor").addEventListener("focusout", (event) => {
    if (state.editor && event.target.getAttribute("aria-invalid") === "true") fillNoteEditor();
  });
  $("note-editor").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") closeNoteEditor();
  });
  $("edit-hear").addEventListener("click", () => {
    audition(editorNotes().map((n) => n.note), editorNotes()[0].velocity);
  });
  $("edit-delete").addEventListener("click", () => {
    changeEditorNotes((found) => {
      slot().notes = notes().filter((n) => !found.includes(n));
    });
    closeNoteEditor();
  });
  $("edit-done").addEventListener("click", () => closeNoteEditor());
  window.addEventListener("pointerdown", (event) => {
    if (!state.editor || $("note-editor").contains(event.target)) return;
    if (!event.target.closest("#grid")) closeNoteEditor({ restoreFocus: false });
  });
}

function closeNoteEditor({ restoreFocus = true } = {}) {
  if (!state.editor) return;
  const cell = cellElement(state.editor.note, state.editor.time);
  state.editor = null;
  $("note-editor").hidden = true;
  if (cell) {
    cell.classList.remove("editing");
    if (restoreFocus) cell.focus();
  }
}

/* ---------- Synth tab ---------- */

const paramControls = new Map();
const SECTION_OF = new Map(ProteinParams.SECTIONS.flatMap((section) => section.params.map((param) => [param.id, section])));

function setView(view) {
  state.view = view === "synth" ? "synth" : "grid";
  $("grid-view").hidden = state.view !== "grid";
  $("synth-view").hidden = state.view !== "synth";
  for (const button of $("views").querySelectorAll("button")) {
    button.setAttribute("aria-current", String(button.dataset.view === state.view));
  }
  if (state.view === "grid") renderGrid();
  else renderParams();
  saveSoon();
}

function renderParams() {
  paramControls.clear();
  $("synth-sections").replaceChildren(...ProteinParams.SECTIONS.map((section) => {
    const card = document.createElement("section");
    card.className = "synth-card";
    const heading = document.createElement("h2");
    heading.textContent = section.name;
    card.append(heading, ...section.params.map(paramRow));
    return card;
  }));
  for (const id of paramControls.keys()) updateParamControl(id);
  renderMapCount();
  renderMapper();
}

function paramRow(param) {
  const row = document.createElement("div");
  row.className = "param";
  row.title = param.help;
  const input = document.createElement("input");
  input.type = "range";
  input.id = `param-${param.id}`;
  input.min = 0;
  input.max = 127;
  input.step = 1;
  input.addEventListener("input", () => setParam(param.id, Number(input.value)));
  const name = document.createElement("label");
  name.htmlFor = input.id;
  name.textContent = param.name;
  const output = document.createElement("output");
  const map = document.createElement("button");
  map.type = "button";
  map.className = "map-button";
  map.addEventListener("click", () => startMapping([param.id]));
  row.append(name, input, output, map);
  paramControls.set(param.id, { param, input, output, map });
  return row;
}

function updateParamControl(id) {
  const control = paramControls.get(id);
  if (!control) return;
  const { param, input, output, map } = control;
  const value = state.values[id];
  const known = value !== undefined;
  const cc = state.mappings[id];
  input.value = known ? value : 64;
  input.disabled = cc === undefined;
  // The Protein can't report its settings, so an untouched slider's position means nothing.
  input.classList.toggle("unknown", !known);
  output.textContent = ProteinParams.display(param, value);
  output.classList.toggle("unknown", !known);
  map.textContent = cc === undefined ? "Map" : `CC ${cc}`;
  map.classList.toggle("mapped", cc !== undefined);
  map.title = cc === undefined ? "Map this setting so its slider controls the Protein" : `Mapped to controller ${cc}. Click to map it again.`;
}

function renderMapCount() {
  const mapped = ProteinParams.ALL.filter((param) => state.mappings[param.id] !== undefined).length;
  $("map-count").textContent = `${mapped} of ${ProteinParams.ALL.length} settings mapped`;
  $("map-count").className = `pill ${mapped ? "ok" : "warn"}`;
  $("map-start").textContent = mapped ? "Map more" : "Set up controls";
}

function sendController(cc, value, atTime) {
  if (!state.output) return false;
  const message = [0xB0 | state.channel, cc, Math.max(0, Math.min(127, Math.round(value)))];
  if (atTime === undefined) state.output.send(message);
  else state.output.send(message, atTime);
  return true;
}

// Sends a setting on its mapped controller, if it has one.
function sendParam(id, value, atTime) {
  const cc = state.mappings[id];
  return cc !== undefined && sendController(cc, value, atTime);
}

function setParam(id, value) {
  state.values[id] = value;
  if (state.mappings[id] === undefined) setStatus(`${ProteinParams.BY_ID.get(id).name} isn't mapped yet. Click Map next to it.`, true);
  else if (!sendParam(id, value)) setStatus("Not sent: no MIDI output connected.", true);
  updateParamControl(id);
}

// Sends a sound to the Protein and shows it on the page. A short gap keeps a burst of
// messages from overrunning it.
function applySound(values) {
  let at = performance.now();
  for (const [id, value] of Object.entries(values)) {
    if (!ProteinParams.BY_ID.has(id)) continue;
    state.values[id] = value;
    if (sendParam(id, value, at)) at += 2;
  }
  renderParams();
  return at;
}

/* ---------- Mapping the Protein's settings ---------- */

function startMapping(ids) {
  if (!ids.length) {
    setStatus("Every setting is mapped. Click CC next to one to map it again.");
    return;
  }
  state.mapping = { queue: ids, index: 0 };
  renderMapper();
  $("mapper").scrollIntoView({ block: "nearest" });
  if (!state.output) setStatus("No MIDI output connected, so nothing can be sent yet. Connect the Protein first.", true);
}

const mappingParam = () => state.mapping && ProteinParams.BY_ID.get(state.mapping.queue[state.mapping.index]);
const mappingCc = (param) => state.mappings[param.id] ?? ProteinParams.freeCc(state.mappings);

function renderMapper() {
  const param = mappingParam();
  $("mapper").hidden = !param;
  for (const row of $("synth-sections").querySelectorAll(".param.mapping")) row.classList.remove("mapping");
  if (!param) return;
  const cc = mappingCc(param);
  const { queue, index } = state.mapping;
  $("mapper-title").textContent = `Map ${SECTION_OF.get(param.id).name}: ${param.name}`;
  $("mapper-progress").textContent = queue.length > 1 ? `${index + 1} of ${queue.length}` : "";
  $("mapper-where").textContent = `On the Protein: ${param.where} Any amount will do.`;
  $("mapper-send-step").textContent = cc === null
    ? "Every controller number this page uses is taken. Forget a mapping you don't need first."
    : `Click Send CC ${cc} here. The Protein maps it to ${param.name}, and sets it to the slider's value.`;
  $("map-send").textContent = cc === null ? "No controller free" : `Send CC ${cc}`;
  $("map-send").disabled = cc === null;
  $("map-forget").hidden = state.mappings[param.id] === undefined;
  paramControls.get(param.id)?.input.closest(".param").classList.add("mapping");
}

function nextMapping() {
  state.mapping.index += 1;
  if (state.mapping.index >= state.mapping.queue.length) {
    state.mapping = null;
    setStatus("Mapping finished. Move a slider to check that the Protein follows it.");
  }
  renderMapper();
}

function sendMapping() {
  const param = mappingParam();
  const cc = mappingCc(param);
  if (!param || cc === null) return;
  const value = state.values[param.id] ?? 64;
  if (!sendController(cc, value)) {
    setStatus("No MIDI output connected. Connect the Protein first.", true);
    return;
  }
  state.mappings[param.id] = cc;
  state.values[param.id] = value;
  updateParamControl(param.id);
  renderMapCount();
  saveSoon();
  setStatus(`Sent CC ${cc} for ${param.name}. Move its slider later to check it took.`);
  nextMapping();
}

function forgetMapping() {
  const param = mappingParam();
  if (!param) return;
  delete state.mappings[param.id];
  updateParamControl(param.id);
  renderMapCount();
  renderMapper();
  saveSoon();
  setStatus(`Forgot ${param.name}'s mapping here. Delete it on the Protein too, under Shift + Settings, Mappings.`);
}

/* ---------- Saved sounds ---------- */

function renderSounds() {
  $("sound").replaceChildren(new Option(state.sounds.length ? "Saved sounds" : "No saved sounds", ""),
    ...state.sounds.map((sound, index) => new Option(sound.name, String(index))));
  $("sound-load").disabled = !state.sounds.length;
  $("sound-delete").disabled = !state.sounds.length;
}

function saveSound() {
  const name = $("sound-name").value.trim();
  if (!name) {
    setStatus("Give the sound a name first.", true);
    $("sound-name").focus();
    return;
  }
  if (!Object.keys(state.values).length) {
    setStatus("Move some sliders first. Only settings the page knows are saved.", true);
    return;
  }
  const existing = state.sounds.findIndex((sound) => sound.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0 && !window.confirm(`Replace the saved sound "${state.sounds[existing].name}"?`)) return;
  const sound = { name, values: { ...state.values } };
  if (existing >= 0) state.sounds[existing] = sound;
  else state.sounds.push(sound);
  renderSounds();
  $("sound").value = String(existing >= 0 ? existing : state.sounds.length - 1);
  saveSoon();
  setStatus(`Saved "${name}" with ${Object.keys(sound.values).length} settings, in this browser.`);
}

function loadSound() {
  const sound = state.sounds[Number($("sound").value)];
  if ($("sound").value === "" || !sound) {
    setStatus("Choose a saved sound first.", true);
    return;
  }
  state.varyOriginal = { ...state.values };
  state.varyLatest = null;
  applySound(sound.values);
  state.varyLatest = { ...state.values };
  renderVary(false);
  $("sound-name").value = sound.name;
  const unmapped = Object.keys(sound.values).filter((id) => state.mappings[id] === undefined).length;
  const skipped = unmapped ? ` ${unmapped} of its settings aren't mapped, so they weren't sent.` : "";
  const sent = state.output ? `Sent "${sound.name}" to the Protein.` : `Loaded "${sound.name}", but no MIDI output is connected.`;
  setStatus(`${sent}${skipped} Hear original brings back the sound you had.`, !state.output);
}

function deleteSound() {
  const index = Number($("sound").value);
  if ($("sound").value === "" || !state.sounds[index]) return;
  if (!window.confirm(`Delete the saved sound "${state.sounds[index].name}"?`)) return;
  const [removed] = state.sounds.splice(index, 1);
  renderSounds();
  saveSoon();
  setStatus(`Deleted "${removed.name}".`);
}

/* ---------- MIDI ---------- */

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiPill("MIDI needs Chrome or Edge", "warn");
    return;
  }
  $("midi-retry").hidden = true;
  try {
    state.midi = await navigator.requestMIDIAccess({ sysex: false });
  } catch (error) {
    setMidiPill("MIDI blocked", "warn");
    $("midi-retry").hidden = false;
    setStatus(`Chrome blocked MIDI (${error.name}). Click the icon left of the address, set MIDI devices to Allow, then click Allow MIDI.`, true);
    return;
  }
  setStatus("MIDI is allowed. Choose a key, then click or drag on the grid to add notes.");
  state.midi.onstatechange = refreshPorts;
  refreshPorts();
}

function setMidiPill(text, kind) {
  $("midi-state").textContent = text;
  $("midi-state").className = `pill ${kind || ""}`;
}

const isProtein = (port) => /protein/i.test(port.name);

function refreshPorts() {
  if (!state.midi) return;
  const outputs = [...state.midi.outputs.values()];
  const previous = state.output && state.output.id;
  $("output").replaceChildren(...outputs.map((port) => new Option(port.name, port.id)));
  state.output = outputs.find((port) => port.id === previous) || outputs.find(isProtein) || null;
  if (state.output) $("output").value = state.output.id;
  if (state.output && isProtein(state.output)) setMidiPill("MIDI: Protein", "ok");
  else if (state.output) setMidiPill(`MIDI: ${state.output.name}`);
  else setMidiPill("Protein not found. Connect it and turn it on.", "warn");

  const input = [...state.midi.inputs.values()].find(isProtein) || null;
  if (input !== state.input) {
    if (state.input) state.input.onmidimessage = null;
    state.input = input;
    if (input) input.onmidimessage = handleMidiInput;
  }
}

// A mapped controller coming back from the Protein, or from a controller passed through
// it, updates the matching slider here. A sound dump is collected while reading.
function handleMidiInput(event) {
  if (event.data[0] === 0xF0) {
    collectDump(event.data);
    return;
  }
  const [status, first, second] = event.data;
  if ((status & 0x0F) !== state.channel || (status & 0xF0) !== 0xB0) return;
  const id = Object.keys(state.mappings).find((key) => state.mappings[key] === first);
  if (id === undefined) return;
  state.values[id] = second;
  updateParamControl(id);
}

/* ---------- Reading a sound dump ---------- */

const DUMP_QUIET_MS = 1500; // A dump is several messages, so it's done once they stop.
const DUMP_WAIT_MS = 120000;
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");

const SEND_HINT = "On the Protein, press Presets, open the Actions menu, and choose Send.";

// SysEx needs its own permission, so it's only asked for when reading.
async function allowSysex() {
  if (!state.midi || !state.midi.sysexEnabled) {
    try {
      state.midi = await navigator.requestMIDIAccess({ sysex: true });
    } catch (error) {
      setStatus(`Chrome didn't allow SysEx (${error.name}). Click the icon left of the address, allow MIDI devices with SysEx, then try again.`, true);
      return false;
    }
    state.midi.onstatechange = refreshPorts;
    state.input = null;
    refreshPorts();
  }
  if (!state.input) {
    setStatus("The Protein isn't connected, so there's nothing to read from.", true);
    return false;
  }
  return true;
}

function listen(message) {
  state.reading = { messages: [], quiet: null, giveUp: window.setTimeout(() => stopReading("No sound dump arrived. Try again, and check the Protein is on the same USB connection.", true), DUMP_WAIT_MS) };
  $("read-protein").textContent = "Stop waiting";
  setStatus(message);
}

async function startReading() {
  if (state.reading) {
    stopReading("Stopped waiting for a sound dump.");
    return;
  }
  if (!(await allowSysex())) return;
  listen(`Waiting for the Protein. ${SEND_HINT}`);
}

function collectDump(data) {
  if (!state.reading) return;
  state.reading.messages.push(Array.from(data));
  window.clearTimeout(state.reading.quiet);
  state.reading.quiet = window.setTimeout(finishDump, DUMP_QUIET_MS);
  setStatus(`Receiving from the Protein: ${state.reading.messages.length} messages so far...`);
}

function finishDump() {
  const { messages } = state.reading;
  state.dump = { messages, at: new Date() };
  $("save-dump").hidden = false;
  let dump;
  try {
    dump = ProteinDump.parse(messages);
  } catch (error) {
    stopReading(`Couldn't read the sound dump: ${error.message}`, true);
    return;
  }
  stopReading("");
  if (state.teach) teachStep(dump);
  else showDump(dump);
}

function stopReading(message, isError = false) {
  if (state.reading) {
    window.clearTimeout(state.reading.quiet);
    window.clearTimeout(state.reading.giveUp);
  }
  state.reading = null;
  $("read-protein").textContent = "Read from Protein";
  if (!message && state.teach) return;
  if (state.teach && isError) endTeaching();
  setStatus(message, isError);
}

// The sliders show the sound the Protein sent. Nothing is sent back, as it already has it.
function showDump(dump) {
  if (!state.readMap) {
    setStatus(`Received "${dump.name}". Click Teach reading once, and after that the sliders follow what the Protein sends.`);
    return;
  }
  const values = ProteinDump.read(dump.values, state.readMap.map, state.readMap.fx);
  resetVary();
  Object.assign(state.values, values);
  renderParams();
  saveSoon();
  setStatus(`Read "${dump.name}" from the Protein: ${Object.keys(values).length} settings.`);
}

/* ---------- Teaching the page to read dumps ---------- */

// The two Sends: one keeps the current sound, and one shows where each taught value went.
async function startTeaching() {
  if (state.teach) {
    endTeaching("Stopped teaching. Nothing was changed.");
    return;
  }
  const ids = ProteinParams.ALL.map((param) => param.id).filter((id) => state.mappings[id] !== undefined);
  if (!ids.length) {
    setStatus("Map some settings first, as teaching works through their controllers.", true);
    return;
  }
  if (!state.output) {
    setStatus("No MIDI output connected. Connect the Protein first.", true);
    return;
  }
  if (!(await allowSysex())) return;
  if (state.reading) stopReading("");
  state.teach = { ids, before: null, sent: null };
  renderTeacher();
  listen(`Teaching, step 1 of 2. ${SEND_HINT}`);
}

function teachStep(dump) {
  const teach = state.teach;
  if (!teach.before) {
    teach.before = dump;
    teach.sent = ProteinDump.teachValues(teach.ids);
    const finished = applySound(teach.sent);
    renderTeacher();
    // Waits for the burst of controllers to be sent before asking for the second dump.
    window.setTimeout(() => {
      if (state.teach === teach) listen(`Teaching, step 2 of 2. The sound has changed on purpose. ${SEND_HINT}`);
    }, Math.max(0, finished - performance.now()) + 200);
    return;
  }
  const learned = ProteinDump.learn(teach.sent, teach.before.values, dump.values);
  state.readMap = { map: learned.map, fx: learned.fx };
  // Puts the sound back as it was before teaching.
  const original = ProteinDump.read(teach.before.values, learned.map, learned.fx);
  endTeaching();
  resetVary();
  applySound(original);
  saveSoon();
  const taught = teach.ids.length - learned.problems.length;
  const names = learned.problems.map((id) => `${SECTION_OF.get(id).name} ${ProteinParams.BY_ID.get(id).name}`);
  const missed = names.length ? ` Couldn't find ${names.join(", ")}, so they won't be read.` : "";
  setStatus(`Taught ${taught} of ${teach.ids.length} settings, and put "${teach.before.name}" back. Read from Protein now updates the sliders.${missed}`, Boolean(names.length));
}

function endTeaching(message) {
  state.teach = null;
  if (state.reading) {
    window.clearTimeout(state.reading.quiet);
    window.clearTimeout(state.reading.giveUp);
    state.reading = null;
    $("read-protein").textContent = "Read from Protein";
  }
  renderTeacher();
  if (message) setStatus(message);
}

function renderTeacher() {
  const teach = state.teach;
  $("teacher").hidden = !teach;
  $("teach-read").textContent = teach ? "Stop teaching" : state.readMap ? "Teach again" : "Teach reading";
  if (!teach) return;
  const second = Boolean(teach.before);
  $("teacher-step").textContent = second ? "Step 2 of 2" : "Step 1 of 2";
  $("teacher-text").textContent = second
    ? `The page has set your ${teach.ids.length} mapped settings to test values, so the sound is different for now. Press Send on the Protein again. Your sound comes back after.`
    : "On the Protein, press Presets, open the Actions menu and choose Send. This keeps a copy of your current sound, so it can be put back afterwards.";
}

// The dump exactly as it arrived, as a .syx file that SysEx tools can send back.
function saveDump() {
  if (!state.dump) return;
  const bytes = new Uint8Array(state.dump.messages.flat());
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const stamp = state.dump.at.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  link.download = `protein-dump-${stamp}.syx`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`Saved ${link.download} to your downloads.`);
}

function sendNote(note, velocity, atTime, lengthMs) {
  if (!state.output) return;
  const value = Math.max(1, Math.min(127, Math.round(velocity * 127)));
  try {
    state.output.send([0x90 | state.channel, note, value], atTime);
    state.output.send([0x80 | state.channel, note, 0], atTime + lengthMs);
  } catch (error) {
    setStatus(`MIDI send failed: ${error.message}`, true);
    stop();
  }
}

function audition(noteList, velocity = 1) {
  if (!noteList.length) return;
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  const now = performance.now();
  noteList.forEach((note) => sendNote(note, velocity, now, 220));
}

/* ---------- Playback ---------- */

const ticker = new Worker(URL.createObjectURL(new Blob(
  ["setInterval(() => postMessage(0), 25);"], { type: "text/javascript" })));
ticker.onmessage = () => { if (state.playing) schedule(); };

const msPerPulse = () => 60000 / (currentBpm() * PPQ);
const sendingClock = () => $("clock").checked;

function currentBpm() {
  const value = Number($("bpm").value);
  return value >= 20 && value <= 300 ? value : 120;
}

function schedule() {
  const horizon = performance.now() + SCHEDULE_AHEAD_MS;
  const ms = msPerPulse();
  while (state.nextTime < horizon) {
    const playing = slot();
    const from = state.nextPulse;
    const to = from + CHUNK_PULSES;
    if (sendingClock() && from % CLOCK_PULSES === 0 && state.output) {
      state.output.send([0xF8], state.nextTime);
    }
    scheduleMotions(from, to, ms);
    for (const note of playing.notes) {
      if (note.time >= from && note.time < to && Math.random() * 100 < (note.probability ?? 100)) {
        for (const part of Music.noteParts(note)) {
          sendNote(note.note, note.velocity, state.nextTime + (part.time - from) * ms, part.length * ms);
        }
      }
    }
    state.nextTime += CHUNK_PULSES * ms;
    state.nextPulse = to >= lengthPulses(playing) ? 0 : to;
    if (state.nextPulse === 0) {
      if (state.queued !== null) switchTo(state.queued);
      else advanceChain();
    }
  }
}

const chainList = () => (state.chainOn ? Music.parseChain(state.chain) || [] : []);

function advanceChain() {
  const chain = chainList();
  if (!chain.length) return;
  state.chainPos = (state.chainPos + 1) % chain.length;
  if (chain[state.chainPos] !== state.current) switchTo(chain[state.chainPos]);
  setStatus(`Chain: pattern ${chain[state.chainPos] + 1}, ${state.chainPos + 1} of ${chain.length}.`);
}

function setChain(text) {
  state.chain = text;
  const valid = Music.parseChain(text) !== null;
  $("chain").setAttribute("aria-invalid", String(!valid));
  if (!valid) setStatus("A chain is pattern numbers from 1 to 16, such as 1 1 2 3.", true);
  saveSoon();
}

// Plays the pattern's drawn knob movements. Each pass starts from the slider's value, as
// the movements only cover part of the pattern.
function scheduleMotions(from, to, ms) {
  const lanes = lanesFor();
  if (!lanes) return;
  const length = lengthPulses();
  for (const [id, points] of Object.entries(lanes)) {
    if (from === 0 && state.values[id] !== undefined) sendParam(id, state.values[id], state.nextTime);
    for (const point of points) {
      if (point.time >= from && point.time < to && point.time < length) {
        sendParam(id, point.value, state.nextTime + (point.time - from) * ms);
      }
    }
  }
}

function restoreAfterMotions() {
  const lanes = lanesFor();
  if (!lanes) return;
  for (const id of Object.keys(lanes)) {
    if (state.values[id] !== undefined) sendParam(id, state.values[id], performance.now() + SCHEDULE_AHEAD_MS + 25);
  }
}

/* ---------- Drawing knob movements ---------- */

const MOTION_TICKS = 30; // 8 points per 1/16 step.

// Movements drawn for a pattern, keyed by setting.
const lanesFor = (index = state.current) => state.slots[index].lanes || null;

function editableLanes() {
  slot().lanes ??= {};
  return slot().lanes;
}

// Only mapped settings can move, along with any that already have movements.
function fillLaneOptions() {
  const lanes = lanesFor() || {};
  const select = $("lane-cc");
  const shown = ProteinParams.ALL.filter((param) => state.mappings[param.id] !== undefined || lanes[param.id]?.length);
  select.replaceChildren(...shown.map((param) => new Option(
    `${lanes[param.id]?.length ? "* " : ""}${SECTION_OF.get(param.id).name} ${param.name}`, param.id)));
  if (!shown.length) select.append(new Option("Map a setting on the Synth tab first", ""));
  if (!shown.some((param) => param.id === state.laneParam)) state.laneParam = shown[0]?.id || "";
  select.value = state.laneParam;
  // Keeps the choice when redrawing, and otherwise suggests the next pattern.
  const target = $("lane-copy-target");
  const chosen = Number(target.value);
  const others = state.slots.map((_, index) => index).filter((index) => index !== state.current);
  target.replaceChildren(...others.map((index) => new Option(`Pattern ${index + 1}`, String(index))));
  target.value = String(target.value !== "" && others.includes(chosen) ? chosen : (state.current + 1) % SLOTS);
}

// Copies every knob's movements, replacing whatever the other pattern has.
function copyLanesToPattern() {
  const lanes = lanesFor() || {};
  if (!Object.values(lanes).some((points) => points.length)) {
    setStatus("This pattern has no knob movements to copy.", true);
    return;
  }
  const index = Number($("lane-copy-target").value);
  const target = state.slots[index];
  const { lanes: copied, cut } = Music.copyLanes(lanes, lengthPulses(target));
  remember();
  target.lanes = copied;
  renderChrome();
  saveSoon();
  const count = Object.keys(copied).length;
  const past = cut ? " Pattern " + (index + 1) + " is shorter, so movements past its end were left out." : "";
  setStatus(`Copied ${count} ${count === 1 ? "knob's" : "knobs'"} movements to pattern ${index + 1}, replacing any it had. Undo takes it back.${past}`);
}

function setLaneVisible(visible) {
  state.showLane = visible;
  $("lane").hidden = !visible;
  $("lane-toggle").setAttribute("aria-pressed", String(visible));
  renderGrid();
  saveSoon();
}

function renderLane() {
  if (!state.showLane) return;
  fillLaneOptions();
  const first = document.querySelector(".cell");
  const last = document.querySelector(".grid > :last-child");
  if (!first || !last) return;
  const left = first.getBoundingClientRect().left;
  const width = last.getBoundingClientRect().right - left;
  const canvas = $("lane-canvas");
  const laneLeft = $("lane").getBoundingClientRect().left + parseFloat(getComputedStyle($("lane")).paddingLeft);
  canvas.style.marginLeft = `${left - laneLeft}px`;
  canvas.style.width = `${width}px`;
  const scale = window.devicePixelRatio || 1;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue("--cell");
  ctx.fillRect(0, 0, width, height);
  const span = state.windowSpan || 1;
  const xAt = (time) => ((time - state.windowStart) / span) * width;
  ctx.fillStyle = style.getPropertyValue("--line");
  for (let time = state.windowStart; time < state.windowStart + span; time += state.resolution) {
    ctx.fillRect(xAt(time), 0, 1, height);
  }
  ctx.fillStyle = style.getPropertyValue("--accent");
  const points = (lanesFor() || {})[state.laneParam] || [];
  for (const point of points) {
    if (point.time < state.windowStart || point.time >= state.windowStart + span) continue;
    const bar = (point.value / 127) * height;
    ctx.fillRect(xAt(point.time), height - bar, Math.max(1, xAt(point.time + MOTION_TICKS) - xAt(point.time)), bar);
  }
  // Where the knob sits outside the drawn movements.
  const resting = state.values[state.laneParam];
  if (resting !== undefined) {
    ctx.fillStyle = style.getPropertyValue("--strong");
    ctx.fillRect(0, height - (resting / 127) * height, width, 1);
  }
}

function setLanePoint(points, time, value, erase) {
  const index = points.findIndex((point) => point.time === time);
  if (erase) {
    if (index >= 0) points.splice(index, 1);
  } else if (index >= 0) {
    points[index].value = value;
  } else {
    points.push({ time, value });
  }
}

function laneStroke(event) {
  const drag = state.laneDraw;
  const box = $("lane-canvas").getBoundingClientRect();
  const x = Math.max(0, Math.min(box.width - 1, event.clientX - box.left));
  const y = Math.max(0, Math.min(box.height, event.clientY - box.top));
  const end = Math.min(state.windowStart + state.windowSpan, lengthPulses());
  const raw = state.windowStart + (x / box.width) * state.windowSpan;
  const time = Math.min(end - MOTION_TICKS, Math.floor(raw / MOTION_TICKS) * MOTION_TICKS);
  const value = Math.round((1 - y / box.height) * 127);
  const points = slot().lanes[state.laneParam];
  // Fills the gap since the last event, as a fast drag skips over points.
  const from = drag.last ? drag.last.time : time;
  const startValue = drag.last ? drag.last.value : value;
  const direction = time >= from ? MOTION_TICKS : -MOTION_TICKS;
  const count = Math.abs(time - from) / MOTION_TICKS;
  for (let index = 0; index <= count; index += 1) {
    const share = count ? index / count : 1;
    setLanePoint(points, from + index * direction, Math.round(startValue + (value - startValue) * share), drag.erase);
  }
  drag.last = { time, value };
  renderLane();
}

function bindLane() {
  const canvas = $("lane-canvas");
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!state.laneParam) {
      setStatus("Map a setting on the Synth tab first, then choose it here.", true);
      return;
    }
    remember();
    editableLanes()[state.laneParam] ??= [];
    state.laneDraw = { erase: event.altKey, last: null };
    canvas.setPointerCapture(event.pointerId);
    laneStroke(event);
    renderChrome();
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.laneDraw) laneStroke(event);
  });
  const finish = () => {
    if (!state.laneDraw) return;
    state.laneDraw = null;
    const lanes = slot().lanes;
    lanes[state.laneParam].sort((a, b) => a.time - b.time);
    if (!lanes[state.laneParam].length) delete lanes[state.laneParam];
    renderLane();
    saveSoon();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  $("lane-cc").addEventListener("change", (event) => {
    state.laneParam = event.target.value;
    renderLane();
    saveSoon();
  });
  $("lane-clear").addEventListener("click", () => {
    if (!(lanesFor() || {})[state.laneParam]?.length) return;
    remember();
    delete editableLanes()[state.laneParam];
    if (state.values[state.laneParam] !== undefined) sendParam(state.laneParam, state.values[state.laneParam]);
    renderLane();
    renderChrome();
    saveSoon();
  });
  $("lane-toggle").addEventListener("click", () => setLaneVisible(!state.showLane));
  $("lane-copy").addEventListener("click", copyLanesToPattern);
}

function renderPeers(names) {
  const pill = $("sync-peers");
  pill.hidden = !$("sync").checked;
  pill.textContent = names.length ? `Linked: ${names.join(", ")}` : "Not linked";
  pill.className = `pill ${names.length ? "ok" : ""}`;
  pill.title = names.length ? "Play, stop and tempo are shared with this page." : "The other grid isn't open in this browser, or has Sync off.";
}

// Plays together with the other grid when both are open. See sync.js.
const link = Sync.connect({
  name: "Protein Grid",
  checkbox: $("sync"),
  storageKey: "protein-grid-sync",
  start({ bpm, at }) {
    if (state.playing) stop({ fromLink: true });
    state.bpm = bpm;
    $("bpm").value = bpm;
    play({ startAt: at, fromLink: true });
    return state.playing;
  },
  stop: () => stop({ fromLink: true }),
  tempo({ bpm, at, pulse }) {
    state.bpm = bpm;
    $("bpm").value = bpm;
    if (!state.playing || !Number.isFinite(pulse)) return;
    state.nextTime = Sync.aligned({
      nextTime: state.nextTime, nextPulse: state.nextPulse, at, pulse, msPerPulse: msPerPulse(), pulsesPerBeat: PPQ,
    });
  },
  status: (message, isError) => setStatus(message, isError),
  peers: renderPeers,
});
renderPeers([]);

const announceTempo = () => link.announceTempo({
  bpm: currentBpm(), nextTime: state.nextTime, nextPulse: state.playing ? state.nextPulse : 0,
});

function play({ startAt = null, fromLink = false } = {}) {
  if (!state.output) {
    setStatus("No MIDI output connected. Connect the Protein and turn it on.", true);
    return;
  }
  state.playing = true;
  state.nextPulse = 0;
  const chain = chainList();
  if (chain.length) {
    state.chainPos = 0;
    if (state.current !== chain[0]) switchTo(chain[0]);
  }
  const shared = fromLink ? null : link.announcePlay(currentBpm());
  state.nextTime = startAt ?? shared ?? performance.now() + 60;
  if (sendingClock()) state.output.send([0xFA], state.nextTime);
  $("play").textContent = "Stop";
  $("playhead").hidden = false;
  schedule();
  requestAnimationFrame(drawPlayhead);
}

function allNotesOff(at) {
  sendController(CC_ALL_NOTES_OFF, 0, at);
}

function stop({ fromLink = false } = {}) {
  state.queued = null;
  if (!state.playing) return;
  if (!fromLink) link.announceStop();
  if (sendingClock() && state.output) state.output.send([0xFC]);
  state.playing = false;
  // Notes already scheduled can still start, so this repeats just after them.
  allNotesOff(performance.now());
  allNotesOff(performance.now() + SCHEDULE_AHEAD_MS + 20);
  restoreAfterMotions();
  $("play").textContent = "Play";
  $("playhead").hidden = true;
  renderSlots();
}

function panic() {
  stop();
  if (!sendController(CC_ALL_SOUND_OFF, 0)) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  allNotesOff();
  setStatus("All notes off.");
}

// Where playback is at a given moment.
function pulseAt(time) {
  const length = lengthPulses();
  const behind = (state.nextTime - time) / msPerPulse();
  return ((state.nextPulse - behind) % length + length) % length;
}

function drawPlayhead() {
  if (!state.playing) return;
  const pulse = pulseAt(performance.now());
  const playingPage = Math.floor(pulse / (state.pageBars * BAR));
  // Page turns redraw the grid, so they wait while a step is being edited.
  if (playingPage !== state.page && !state.editor && !state.lengthDrag && !state.paint) goToPage(playingPage);
  const firstCell = document.querySelector(".cell");
  const lastCell = document.querySelector(".grid > :last-child");
  if (firstCell && lastCell) {
    const origin = firstCell.offsetLeft;
    const width = lastCell.offsetLeft + lastCell.offsetWidth - origin;
    const head = $("playhead");
    head.style.left = `${origin + ((pulse - state.windowStart) / state.windowSpan) * width}px`;
    head.style.height = `${$("grid").offsetHeight}px`;
    head.hidden = playingPage !== state.page;
  }
  requestAnimationFrame(drawPlayhead);
}

function exportMidi() {
  if (!notes().length) {
    setStatus("This pattern has no notes to export.", true);
    return;
  }
  const bytes = Music.midiFile(notes(), { bpm: currentBpm(), channel: state.channel });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  const key = `${Music.NOTE_NAMES[state.root].replace("#", "sharp")}-${state.scale}`;
  link.download = `protein-grid-pattern-${state.current + 1}-${key}.mid`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`Exported pattern ${state.current + 1}.`);
}

function downloadBackup() {
  const file = new Blob([JSON.stringify(Backup.pack(state))], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `protein-grid-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("Saved all 16 patterns, saved sounds and mappings to a file.");
}

async function restoreBackup(file) {
  let data;
  try {
    data = Backup.unpack(JSON.parse(await file.text()), { scales: Music.SCALES, params: ProteinParams.BY_ID });
  } catch (error) {
    setStatus(`Couldn't restore ${file.name}: ${error.message}`, true);
    return;
  }
  if (state.slots.some((item) => item.notes.length)
    && !window.confirm(`Replace all 16 patterns with the ones in ${file.name}?`)) return;
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  const { values, ...rest } = data;
  Object.assign(state, rest);
  state.page = 0;
  state.mapping = null;
  resetVary();
  applySound(values);
  $("chain").value = state.chain;
  $("chain-on").checked = state.chainOn;
  renderSounds();
  renderAll();
  saveSoon();
  setStatus(`Restored ${file.name}. Undo brings back the patterns you had.`);
}

const IMPORT_BARS = [1, 2, 4, 8];

// Replaces the current pattern, which Undo brings back. The sound doesn't change.
async function importMidi(file) {
  let parsed;
  try {
    parsed = Music.parseMidi(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    setStatus(`Couldn't read ${file.name}: ${error.message}`, true);
    return;
  }
  if (!parsed.notes.length) {
    setStatus(`${file.name} has no notes to import.`, true);
    return;
  }
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  const end = Math.max(...parsed.notes.map((n) => n.time + n.length));
  const bars = IMPORT_BARS.find((count) => end <= count * BAR) ?? IMPORT_BARS.at(-1);
  const limit = bars * BAR;
  const kept = parsed.notes
    .filter((n) => n.time < limit)
    .map((n) => ({ ...n, length: Math.min(n.length, limit - n.time) }));
  slot().bars = bars;
  slot().notes = kept;
  delete slot().lanes;
  if (parsed.bpm) state.bpm = Math.max(20, Math.min(300, Math.round(parsed.bpm * 10) / 10));
  const key = Music.detectKey(kept);
  if (key) Object.assign(state, key);
  const lowest = Math.min(...kept.map((n) => n.note));
  state.lowOctave = Math.max(1, Math.min(6, Math.floor(lowest / 12) - 1));
  state.page = 0;
  renderAll();
  saveSoon();
  const cut = end > limit ? ` It's longer than ${bars} bars, so the rest was cut.` : "";
  const count = `${kept.length} ${kept.length === 1 ? "note" : "notes"}`;
  setStatus(`Imported ${count} from ${file.name} into pattern ${state.current + 1}. Undo brings the old one back.${cut}`);
}

const THEME_KEY = "protein-grid-theme";

function setTheme(theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = theme === "light" ? "Dark mode" : "Light mode";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private windows can refuse storage, so the theme just isn't remembered.
  }
  renderLane();
}

/* ---------- Sound variations ---------- */

function resetVary() {
  state.varyOriginal = null;
  state.varyLatest = null;
  renderVary(false);
}

function renderVary(showingOriginal) {
  $("vary-compare").disabled = !state.varyOriginal;
  $("vary-compare").textContent = showingOriginal ? "Hear new" : "Hear original";
  $("vary-compare").setAttribute("aria-pressed", String(showingOriginal));
}

function varySound(amount) {
  const { changes, unknown } = ProteinParams.vary(state.values, amount);
  if (!Object.keys(changes).length) {
    setStatus("Vary needs known values. Move some sliders, or load a saved sound, first.", true);
    return;
  }
  state.varyOriginal ??= { ...state.values };
  applySound(changes);
  state.varyLatest = { ...state.values };
  renderVary(false);
  const skipped = unknown ? ` ${unknown} settings showing ? were left alone.` : "";
  setStatus(`Changed ${Object.keys(changes).length} controls. Hear original compares them.${skipped}`);
}

function compareVary() {
  const showingOriginal = $("vary-compare").getAttribute("aria-pressed") === "true";
  if (!showingOriginal) state.varyLatest = { ...state.values };
  applySound(showingOriginal ? state.varyLatest : state.varyOriginal);
  renderVary(!showingOriginal);
  setStatus(showingOriginal ? "Hearing the new version." : "Hearing the original.");
}

/* ---------- Controls ---------- */

function openHelp() {
  closeNoteEditor({ restoreFocus: false });
  $("help").showModal();
  document.querySelector(".help-body").scrollTop = 0;
}

function fillSelects() {
  $("scale").replaceChildren(...Object.entries(Music.SCALES).map(
    ([id, scale]) => new Option(scale.name, id)));
  $("generator").replaceChildren(...Object.entries(Music.GENERATORS).map(
    ([id, name]) => new Option(name, id)));
  const octaves = [];
  for (let octave = 1; octave <= 6; octave += 1) octaves.push(new Option(`C${octave}`, String(octave)));
  $("octave").replaceChildren(...octaves);
  const channels = [];
  for (let channel = 1; channel <= 16; channel += 1) channels.push(new Option(String(channel), String(channel)));
  $("channel").replaceChildren(...channels);
  $("chords").replaceChildren(...Object.entries(Music.CHORDS).map(([id, chord]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.value = id;
    button.textContent = chord.name;
    button.addEventListener("click", () => {
      state.chord = id;
      renderStepControls();
      saveSoon();
      if (id !== "note") setStatus(`Drawing ${chord.name.toLowerCase()} chords in the key.`);
    });
    return button;
  }));
}

function bindControls() {
  const number = (id, apply) => $(id).addEventListener("change", (event) => {
    apply(Number(event.target.value));
    saveSoon();
  });
  $("scale").addEventListener("change", (event) => setKey(state.root, event.target.value));
  $("move-notes").addEventListener("change", (event) => {
    state.moveNotes = event.target.checked;
    saveSoon();
  });
  $("steps").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setSteps(Number(button.dataset.value), state.triplets);
  });
  $("triplets").addEventListener("click", () => setSteps(state.baseResolution, !state.triplets));
  number("bars", setBars);
  number("bpm", (value) => { state.bpm = currentBpm(); $("bpm").value = state.bpm; announceTempo(); void value; });
  number("octave", (value) => { state.lowOctave = value; renderGrid(); });
  number("span", (value) => { state.span = value; renderGrid(); });
  number("channel", (value) => { state.channel = value - 1; });
  $("new-length").addEventListener("change", (event) => { state.newLength = event.target.value; saveSoon(); });
  $("show-all").addEventListener("change", (event) => {
    state.showAll = event.target.checked;
    renderGrid();
    saveSoon();
  });
  $("output").addEventListener("change", (event) => {
    state.output = state.midi.outputs.get(event.target.value) || null;
    if (state.output) setMidiPill(`MIDI: ${state.output.name}`, isProtein(state.output) ? "ok" : "");
  });
  $("page-prev").addEventListener("click", () => goToPage(state.page - 1));
  $("page-next").addEventListener("click", () => goToPage(state.page + 1));
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderGrid, 100);
  });
  $("midi-retry").addEventListener("click", initMidi);
  $("play").addEventListener("click", () => (state.playing ? stop() : play()));
  $("stop-all").addEventListener("click", panic);
  $("export").addEventListener("click", exportMidi);
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    // Cleared so that choosing the same file again still counts as a change.
    event.target.value = "";
    if (file) importMidi(file);
  });
  $("shift-left").addEventListener("click", () => shiftInTime(-1));
  $("shift-right").addEventListener("click", () => shiftInTime(1));
  $("scale-down").addEventListener("click", () => shiftInScale(-1));
  $("scale-up").addEventListener("click", () => shiftInScale(1));
  $("copy").addEventListener("click", copySelection);
  $("paste").addEventListener("click", pasteClipboard);
  $("velocity-set").addEventListener("click", setBulkVelocity);
  $("chain").addEventListener("change", (event) => setChain(event.target.value));
  $("chain-on").addEventListener("change", (event) => {
    state.chainOn = event.target.checked;
    saveSoon();
  });
  $("backup").addEventListener("click", downloadBackup);
  $("restore").addEventListener("click", () => $("restore-file").click());
  $("restore-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (file) restoreBackup(file);
  });
  $("vary-small").addEventListener("click", () => varySound(0.06));
  $("theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $("theme-toggle").textContent = document.documentElement.dataset.theme === "light" ? "Dark mode" : "Light mode";
  $("vary-big").addEventListener("click", () => varySound(0.25));
  $("vary-compare").addEventListener("click", compareVary);
  $("octave-down").addEventListener("click", () => shiftOctave(-1));
  $("octave-up").addEventListener("click", () => shiftOctave(1));
  $("generate").addEventListener("click", generatePattern);
  $("undo").addEventListener("click", undo);
  $("duplicate").addEventListener("click", duplicatePattern);
  $("clear").addEventListener("click", () => {
    if (!notes().length) return;
    remember();
    slot().notes = [];
    renderGrid();
    renderChrome();
    saveSoon();
  });
  $("sound-load").addEventListener("click", loadSound);
  $("sound-delete").addEventListener("click", deleteSound);
  $("sound-save").addEventListener("click", saveSound);
  $("sound-name").addEventListener("keydown", (event) => { if (event.key === "Enter") saveSound(); });
  $("map-start").addEventListener("click", () => startMapping(ProteinParams.MAPPING_ORDER.filter((id) => state.mappings[id] === undefined)));
  $("map-send").addEventListener("click", sendMapping);
  $("read-protein").addEventListener("click", startReading);
  $("teach-read").addEventListener("click", startTeaching);
  $("teacher-stop").addEventListener("click", () => endTeaching("Stopped teaching. Your sound may still have the test values, so use Hear original or load a preset."));
  $("save-dump").addEventListener("click", saveDump);
  $("map-skip").addEventListener("click", nextMapping);
  $("map-forget").addEventListener("click", forgetMapping);
  $("map-stop").addEventListener("click", () => {
    state.mapping = null;
    renderMapper();
  });
  $("views").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setView(button.dataset.view);
  });
  $("help-open").addEventListener("click", openHelp);
  $("help-close").addEventListener("click", () => $("help").close());
  $("help").addEventListener("click", (event) => {
    if (event.target === $("help")) $("help").close();
  });

  const typing = (target) => /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  window.addEventListener("keydown", (event) => {
    if ($("help").open) return;
    if (event.key === "?" && !typing(event.target)) {
      openHelp();
      return;
    }
    if (event.key === "Escape" && state.editor) {
      closeNoteEditor();
      return;
    }
    // Space is the transport wherever you've last clicked, unless you're writing text.
    const writing = event.target.tagName === "TEXTAREA" || /^(text|search)$/.test(event.target.type);
    if (event.code === "Space" && !writing && !event.metaKey && !event.ctrlKey && !event.altKey
      && !event.target.closest?.("#note-editor") && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      if (!event.repeat) {
        if (state.playing) stop(); else play();
      }
      return;
    }
    if (typing(event.target) || event.target.closest?.("#note-editor")) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "c") {
      event.preventDefault();
      copySelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "v") {
      event.preventDefault();
      pasteClipboard();
    } else if (event.key === "Escape") {
      clearSelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      undo();
    } else if (event.key === "t" && !event.metaKey && !event.ctrlKey) {
      setSteps(state.baseResolution, !state.triplets);
    }
  });
}

async function start() {
  restore();
  fillSelects();
  bindControls();
  bindGridEvents();
  bindNoteEditor();
  bindLane();
  $("edit-substep").replaceChildren(...Music.SUB_STEPS.map((pattern, index) => new Option(index ? pattern.replaceAll("_", "-") : "Off", String(index))));
  $("chain").value = state.chain;
  $("chain-on").checked = state.chainOn;
  $("lane").hidden = !state.showLane;
  $("lane-toggle").setAttribute("aria-pressed", String(state.showLane));
  renderSounds();
  renderAll();
  renderTeacher();
  setView(state.view);
  setStatus("Choose a key, then click or drag on the grid to add notes.");
  await initMidi();
}

start().catch((error) => setStatus(error.message, true));
