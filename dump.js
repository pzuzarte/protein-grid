"use strict";
/* Reads the sound dump the Protein sends from Presets, Actions, Send. Waldorf doesn't
   document it, so this is worked out from real dumps:
   - Each message is F0 3E 2F <device> 10 03 <count> <index> ... <checksum> F7, where the
     checksum is the low 7 bits of the sum of every byte after F0.
   - The first message's data starts with 2 bytes and the sound's 24-byte name.
   - Then come 10-byte records: a 4-letter name, then a 32-bit float, each sent as five
     7-bit bytes. Names end in the layer, 1-4, such as fcu1 for layer A's cutoff.
   Teaching sets each mapped setting to a known value, and the dump that follows shows
   which name holds it and how its value converts back to a controller value. */
const ProteinDump = (() => {
  const HEADER = [0xF0, 0x3E, 0x2F];
  const RECORD = 10;
  const NAME_BYTES = 26;

  const bits = (bytes) => bytes.reduce((value, byte) => ((value << 7) | byte) >>> 0, 0) >>> 0;
  const text = (number) => String.fromCharCode(number >>> 24, (number >>> 16) & 0xFF, (number >>> 8) & 0xFF, number & 0xFF);

  function toFloat(number) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, number);
    return view.getFloat32(0);
  }

  // The messages of one dump, as arrays of bytes, to its name and settings.
  function parse(messages) {
    if (!messages.length) throw new Error("Nothing arrived.");
    const values = {};
    let name = "";
    messages.forEach((message, index) => {
      if (HEADER.some((byte, at) => message[at] !== byte) || message[4] !== 0x10 || message.at(-1) !== 0xF7) {
        throw new Error("It isn't a Protein sound dump.");
      }
      const sum = message.slice(1, -2).reduce((total, byte) => total + byte, 0) & 0x7F;
      if (sum !== message.at(-2)) throw new Error(`Message ${index + 1} arrived damaged. Try sending it again.`);
      let data = message.slice(8, -2);
      if (index === 0) {
        name = String.fromCharCode(...data.slice(2, NAME_BYTES).filter((byte) => byte >= 0x20 && byte < 0x7F)).trim();
        data = data.slice(NAME_BYTES);
      }
      if (data.length % RECORD) throw new Error(`Message ${index + 1} has an unexpected length.`);
      for (let at = 0; at < data.length; at += RECORD) {
        values[text(bits(data.slice(at, at + 5)))] = toFloat(bits(data.slice(at + 5, at + RECORD)));
      }
    });
    if (messages.length !== messages[0][6]) throw new Error(`Only ${messages.length} of its ${messages[0][6]} messages arrived. Try sending it again.`);
    return { name, values };
  }

  // Best guesses at where each of the page's settings lives, for layer A, from the names.
  const GUESSES = {
    glide: "gli1",
    flavour: "flav",
    "filter.cutoff": "fcu1",
    "filter.resonance": "fre1",
    "filter.envAmount": "fce1",
    "filter.envVelocity": "fve1",
    "filter.keytrack": "fkt1",
    "filter.dirt": "nsv1",
    "amp.volume": "lav1",
    "amp.pan": "lap1",
  };
  for (const n of [1, 2]) {
    Object.assign(GUESSES, {
      [`osc${n}.table`]: `w${n}t1`,
      [`osc${n}.wave`]: `w${n}p1`,
      [`osc${n}.level`]: `o${n}v1`,
      [`osc${n}.envAmount`]: `w${n}e1`,
      [`osc${n}.envVelocity`]: `w${n}v1`,
      [`osc${n}.semitone`]: `o${n}s1`,
      [`osc${n}.detune`]: `o${n}d1`,
      [`lfo${n}.speed`]: `l${n}p1`,
      [`lfo${n}.shape`]: `l${n}h1`,
      [`lfo${n}.ratio`]: `l${n}r1`,
    });
  }
  for (const [env, stem] of [["waveEnv", "we"], ["filterEnv", "fe"], ["ampEnv", "ae"]]) {
    for (const stage of ["attack", "decay", "sustain", "release"]) GUESSES[`${env}.${stage}`] = `${stem}${stage[0]}1`;
  }
  for (let slot = 1; slot <= 8; slot += 1) GUESSES[`mod${slot}.amount`] = `ma${slot}1`;

  // Settings that are stored as whole numbers, such as which wavetable.
  const STEPPED = new Set(["osc1.table", "osc2.table", "osc1.wave", "osc2.wave", "osc1.semitone", "osc2.semitone",
    "lfo1.shape", "lfo2.shape", "lfo1.ratio", "lfo2.ratio"]);

  /* The effect amounts are the dry/wet of whichever effect is in the slot, so their name
     depends on the slot's type (fxt1 or fxt2). The order is the manual's, and teaching
     confirms it for the types in use then. */
  const FX_PREFIXES = ["ch", "fl", "ph", "tr", "dr", "cp", "eq", "dl", "rv"];
  const FX_FIRST = 1;
  const isFx = (id) => /^fx[12]\.amount$/.test(id);

  function fxKey(id, values, fx = {}) {
    const type = values[`fxt${id[2]}`];
    const prefix = fx[type] ?? FX_PREFIXES[type - FX_FIRST];
    return prefix ? `${prefix}dw` : null;
  }

  const toCc = (value) => Math.max(0, Math.min(127, Math.round(value * 127)));

  // A stepped value's controller value: the middle of the range that selects it.
  const steppedCc = (index, steps) => Math.max(0, Math.min(127, Math.round(((index + 0.5) * 128) / steps - 0.5)));

  /* The values sent while teaching: each smooth setting gets its own value, so it can be
     found even where the guess is wrong, and each stepped one goes to the top, so its
     number of steps shows. */
  function teachValues(ids) {
    const sent = {};
    let next = 17;
    for (const id of ids) {
      if (STEPPED.has(id)) {
        sent[id] = 127;
      } else {
        sent[id] = next;
        next += 2;
        if (next === 63 || next === 64 || next === 65) next = 67;
      }
    }
    return sent;
  }

  /* Works out how to read each taught setting from the dump taken after teaching, and
     the one before it, which tells apart names that only happen to match. */
  function learn(sent, before, after) {
    const map = {};
    const fx = { taught: [], types: {} };
    const problems = [];
    const taken = new Set();
    const changed = (key) => before[key] !== after[key];
    for (const [id, cc] of Object.entries(sent)) {
      if (STEPPED.has(id)) {
        const key = GUESSES[id];
        const top = after[key];
        if (Number.isInteger(top) && top > 0) {
          map[id] = { key, steps: top + 1 };
          taken.add(key);
        } else {
          problems.push(id);
        }
        continue;
      }
      // Exact first, then one off, as settings with a middle point may round differently.
      const fits = (key, slack) => key in after && !taken.has(key) && Math.abs(toCc(after[key]) - cc) <= slack;
      const guess = isFx(id) ? fxKey(id, after) : GUESSES[id];
      const search = (slack) => {
        if (fits(guess, slack)) return guess;
        const pool = Object.keys(after).filter((name) => (isFx(id) ? /dw$/.test(name) : true) && fits(name, slack));
        const moved = pool.filter(changed);
        if (moved.length === 1) return moved[0];
        return slack === 0 && pool.length === 1 ? pool[0] : null;
      };
      const key = search(0) ?? search(1);
      if (!key) {
        problems.push(id);
        continue;
      }
      taken.add(key);
      if (isFx(id)) {
        fx.types[after[`fxt${id[2]}`]] = key.slice(0, 2);
        fx.taught.push(id);
      } else {
        map[id] = { key };
      }
    }
    return { map, fx, problems };
  }

  // Controller values for every setting that's been taught, from a dump.
  function read(values, map, fx) {
    const result = {};
    for (const [id, rule] of Object.entries(map)) {
      const value = values[rule.key];
      if (value === undefined) continue;
      result[id] = rule.steps ? steppedCc(Math.round(value), rule.steps) : toCc(value);
    }
    for (const id of fx.taught) {
      const key = fxKey(id, values, fx.types);
      if (key && key in values) result[id] = toCc(values[key]);
    }
    return result;
  }

  return { FX_PREFIXES, GUESSES, STEPPED, learn, parse, read, steppedCc, teachValues };
})();

if (typeof module !== "undefined") module.exports = ProteinDump;
