"use strict";
/* The Protein's sound settings, from its manual. The Protein has no fixed MIDI controller
   numbers: each setting is mapped on the synth itself to a controller this page sends,
   so every setting here has a hint for finding it on the front panel. */
const ProteinParams = (() => {
  const level = (id, name, where, help) => ({ id, name, where, help, type: "level" });
  const bipolar = (id, name, where, help) => ({ id, name, where, help, type: "bipolar" });

  const osc = (n) => {
    const pick = `Choose Osc ${n} with the Select encoder, then`;
    return {
      id: `osc${n}`,
      name: `Osc ${n}`,
      params: [
        level(`osc${n}.table`, "Table", `${pick} turn the Table encoder.`, "Which of the Microwave 1 wavetables this oscillator plays."),
        level(`osc${n}.wave`, "Wave", `${pick} turn the Wave dial.`, "Where in the wavetable the sound starts. The last three are triangle, square and sawtooth."),
        level(`osc${n}.level`, "Level", `${pick} hold Shift and turn the dial with the blue Level label.`, "This oscillator's volume."),
        bipolar(`osc${n}.envAmount`, "Env amount", `${pick} turn Env Amnt in the Wave section.`, "How far the wave envelope moves through the wavetable."),
        bipolar(`osc${n}.envVelocity`, "Env velocity", `${pick} hold Shift and turn the dial with the blue Vel label in the Wave section.`, "How much playing harder moves through the wavetable."),
        bipolar(`osc${n}.semitone`, "Semitone", `${pick} turn the Semitone encoder.`, "Pitch in semitones, such as +7 for a fifth."),
        bipolar(`osc${n}.detune`, "Detune", `${pick} turn Detune.`, "Fine tuning, up to a semitone either way."),
      ],
    };
  };

  const envelope = (id, name, menu) => ({
    id,
    name,
    params: ["Attack", "Decay", "Sustain", "Release"].map((stage) => level(`${id}.${stage.toLowerCase()}`, stage,
      `Choose ${menu} in the Envelopes section's display, then turn the ${stage} dial.`,
      `The ${name.toLowerCase()}'s ${stage.toLowerCase()}.`)),
  });

  const lfo = (n) => ({
    id: `lfo${n}`,
    name: `LFO ${n}`,
    params: [
      level(`lfo${n}.speed`, "Speed", `Choose LFO ${n}, then turn the Speed dial.`, "How fast it moves, when not synced to the tempo."),
      level(`lfo${n}.shape`, "Shape", `Choose LFO ${n}, then hold Shift and turn the dial with the blue Shape label.`, "Sine, triangle, pulse, saw, saw up, random or sample and hold."),
      level(`lfo${n}.ratio`, "Ratio", `Choose LFO ${n}, then hold Shift and turn the dial with the blue Ratio label.`, "Its speed as a note value, from 4 bars to 1/64, when Clocked."),
    ],
  });

  const SECTIONS = [
    osc(1),
    osc(2),
    {
      id: "pitch",
      name: "Pitch",
      params: [
        level("glide", "Glide", "Turn the Glide dial.", "How long notes slide into each other."),
        level("flavour", "Flavour", "Turn the Flavour dial.", "Small, deliberate variations in wave position and pitch."),
      ],
    },
    {
      id: "filter",
      name: "Filter",
      params: [
        level("filter.cutoff", "Cutoff", "Turn the Cutoff dial.", "Brightness. With Drive on, the amount of drive."),
        level("filter.resonance", "Resonance", "Turn the Resonance dial.", "Emphasis at the cutoff. Above about 0.80 it rings like a sine wave."),
        bipolar("filter.envAmount", "Env amount", "Turn Env Amnt in the Filter section.", "How far the filter envelope opens or closes the filter."),
        bipolar("filter.envVelocity", "Env velocity", "Hold Shift and turn the dial with the blue Vel label in the Filter section.", "How much playing harder moves the filter envelope."),
        bipolar("filter.keytrack", "Keytrack", "Hold Shift and turn the dial with the blue Track label.", "How much higher notes open the filter, from C3."),
        level("filter.dirt", "Dirt", "Hold Shift and turn the dial with the blue Dirt label.", "Noise and clicks added to the sound."),
      ],
    },
    envelope("waveEnv", "Wave envelope", "Wave Env"),
    envelope("filterEnv", "Filter envelope", "Filter Env"),
    envelope("ampEnv", "Amp envelope", "Amp Env"),
    {
      id: "amp",
      name: "Amp",
      params: [
        level("amp.volume", "Volume", "Hold Shift and turn the dial with the blue Volume label in the Envelopes section.", "The sound's volume."),
        bipolar("amp.pan", "Pan", "Hold Shift and turn the dial with the blue Pan label in the Envelopes section.", "Where the sound sits between left and right."),
      ],
    },
    lfo(1),
    lfo(2),
    {
      id: "mod",
      name: "Mod amounts",
      params: Array.from({ length: 8 }, (_, index) => bipolar(`mod${index + 1}.amount`, `Slot ${index + 1}`,
        `In the Mod page, choose slot ${index + 1} with the Select encoder, then turn the Amount dial.`,
        `How much modulation slot ${index + 1} applies. Its source and target are set on the Protein.`)),
    },
    {
      id: "fx",
      name: "Effects",
      params: [
        level("fx1.amount", "FX 1 amount", "In the FX page, choose FX 1 with the Select encoder, then turn the Amount dial.", "How much of the first effect you hear."),
        level("fx2.amount", "FX 2 amount", "In the FX page, choose FX 2 with the Select encoder, then turn the Amount dial.", "How much of the second effect you hear."),
      ],
    },
  ];

  const ALL = SECTIONS.flatMap((section) => section.params);
  const BY_ID = new Map(ALL.map((param) => [param.id, param]));

  // The order the mapping guide offers them in: what you reach for most comes first.
  const ESSENTIALS = ["filter.cutoff", "filter.resonance", "filter.envAmount", "ampEnv.attack", "ampEnv.decay",
    "ampEnv.sustain", "ampEnv.release", "filterEnv.attack", "filterEnv.decay", "filterEnv.sustain", "filterEnv.release",
    "osc1.wave", "osc2.wave", "osc1.table", "osc2.table", "osc2.level", "glide", "lfo1.speed", "fx1.amount", "fx2.amount"];
  const MAPPING_ORDER = [...ESSENTIALS, ...ALL.map((param) => param.id).filter((id) => !ESSENTIALS.includes(id))];

  /* Controllers the page hands out for mappings. Left out are the ones MIDI or the Protein
     already use: bank select (0, 32), mod wheel (1), breath (2), data entry and NRPN
     (6, 38, 96-101), volume and pan (7, 10), expression (11), CC22-31 (the Protein's
     modulation sources), sustain and the other pedals (64-69), and channel modes (120-127). */
  const RESERVED = new Set([0, 1, 2, 6, 7, 10, 11, 32, 38, 64, 65, 66, 67, 68, 69, 96, 97, 98, 99, 100, 101]);
  const CC_POOL = [];
  for (let cc = 3; cc < 120; cc += 1) {
    if (!RESERVED.has(cc) && !(cc >= 22 && cc <= 31)) CC_POOL.push(cc);
  }

  // The first spare controller, or null once they've all been handed out.
  function freeCc(mappings) {
    const used = new Set(Object.values(mappings));
    return CC_POOL.find((cc) => !used.has(cc)) ?? null;
  }

  function display(param, value) {
    if (value === undefined) return "?";
    if (param.type === "bipolar") return value === 64 ? "0" : `${value > 64 ? "+" : ""}${value - 64}`;
    return String(value);
  }

  // Left out of Vary: tuning, which puts a sound out of tune, and pan and volume, which are for mixing.
  const NOT_VARIED = new Set(["osc1.semitone", "osc2.semitone", "osc1.detune", "osc2.detune", "amp.volume", "amp.pan"]);

  // Nudges every known setting by up to the given share of its range, and returns the changes.
  function vary(values, amount, random = Math.random) {
    const changes = {};
    let unknown = 0;
    for (const param of ALL) {
      if (NOT_VARIED.has(param.id)) continue;
      const value = values[param.id];
      if (value === undefined) {
        unknown += 1;
        continue;
      }
      changes[param.id] = Math.max(0, Math.min(127, Math.round(value + (random() * 2 - 1) * amount * 127)));
    }
    return { changes, unknown };
  }

  return { ALL, BY_ID, CC_POOL, MAPPING_ORDER, SECTIONS, display, freeCc, vary };
})();

if (typeof module !== "undefined") module.exports = ProteinParams;
