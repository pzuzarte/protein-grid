"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Backup = require("../backup.js");
const Music = require("../music.js");
const ProteinParams = require("../params.js");

const options = { scales: Music.SCALES, params: ProteinParams.BY_ID };

const fullState = () => ({
  root: 2,
  scale: "minor",
  bpm: 98,
  chain: "1 2",
  chainOn: true,
  values: { "filter.cutoff": 90, "ampEnv.attack": 3 },
  mappings: { "filter.cutoff": 3, "ampEnv.attack": 4 },
  sounds: [{ name: "Pad", values: { "filter.cutoff": 50 } }],
  slots: Array.from({ length: 16 }, (_, index) => ({
    bars: 1,
    notes: index ? [] : [{ time: 0, note: 60, velocity: 1, length: 240, probability: 100 }],
    ...(index ? {} : { lanes: { "filter.cutoff": [{ time: 0, value: 10 }] } }),
  })),
});

test("every setting has a unique id, a name and a hint for finding it on the Protein", () => {
  const ids = ProteinParams.ALL.map((param) => param.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const param of ProteinParams.ALL) {
    assert.ok(param.name && param.where && param.help, param.id);
    assert.ok(["level", "bipolar"].includes(param.type), param.id);
  }
  assert.deepEqual([...ProteinParams.MAPPING_ORDER].sort(), [...ids].sort());
  assert.equal(ProteinParams.MAPPING_ORDER[0], "filter.cutoff");
});

test("mappings are handed controllers that MIDI and the Protein don't already use", () => {
  for (const cc of [0, 1, 2, 6, 7, 10, 11, 22, 31, 32, 38, 64, 98, 99, 120, 123]) {
    assert.ok(!ProteinParams.CC_POOL.includes(cc), `CC ${cc}`);
  }
  assert.ok(ProteinParams.CC_POOL.length >= ProteinParams.ALL.length);
  assert.equal(ProteinParams.freeCc({}), 3);
  assert.equal(ProteinParams.freeCc({ a: 3, b: 4 }), 5);
  const all = Object.fromEntries(ProteinParams.CC_POOL.map((cc, index) => [`p${index}`, cc]));
  assert.equal(ProteinParams.freeCc(all), null);
});

test("bipolar settings show 0 at the middle", () => {
  const pan = ProteinParams.BY_ID.get("amp.pan");
  assert.equal(ProteinParams.display(pan, 64), "0");
  assert.equal(ProteinParams.display(pan, 70), "+6");
  assert.equal(ProteinParams.display(pan, 0), "-64");
  assert.equal(ProteinParams.display(ProteinParams.BY_ID.get("filter.cutoff"), undefined), "?");
});

test("vary only nudges known settings, and leaves tuning, pan and volume alone", () => {
  const { changes, unknown } = ProteinParams.vary({ "filter.cutoff": 100, "amp.pan": 64, "osc1.semitone": 70 }, 0.1, () => 1);
  assert.deepEqual(Object.keys(changes), ["filter.cutoff"]);
  assert.equal(changes["filter.cutoff"], 113);
  assert.equal(unknown, ProteinParams.ALL.length - 6 - 1);
  assert.equal(ProteinParams.vary({ "filter.cutoff": 127 }, 0.5, () => 1).changes["filter.cutoff"], 127);
});

test("a backup restores patterns, sound, saved sounds and mappings", () => {
  const back = Backup.unpack(JSON.parse(JSON.stringify(Backup.pack(fullState(), new Date(0)))), options);
  const original = fullState();
  assert.deepEqual(back.mappings, original.mappings);
  assert.deepEqual(back.sounds, original.sounds);
  assert.deepEqual(back.values, original.values);
  assert.deepEqual(back.slots[0], original.slots[0]);
  assert.equal(back.chain, "1 2");
});

test("a damaged or unrelated backup is refused, and unknown settings are dropped", () => {
  const damaged = (change) => {
    const file = JSON.parse(JSON.stringify(Backup.pack(fullState())));
    change(file);
    return file;
  };
  assert.throws(() => Backup.unpack({ app: "s1-grid" }, options), /isn't a Protein Grid backup/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.version = 2; }), options), /different version/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.mappings["amp.pan"] = 3; }), options), /controller mapping/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.mappings["amp.pan"] = 200; }), options), /controller mapping/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.slots[0].lanes = { nonsense: [] }; }), options), /knob movement/);
  const kept = Backup.unpack(damaged((f) => { f.values.nonsense = 5; f.values["amp.pan"] = 400; }), options);
  assert.deepEqual(kept.values, fullState().values);
});
