"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ProteinDump = require("../dump.js");

// Builds a dump the way the Protein sends one, so these tests need no real one.
function encode(name, values, perMessage = 40) {
  const seven = (number) => [28, 21, 14, 7, 0].map((shift) => (number >>> shift) & 0x7F).map((byte, index) => (index === 0 ? (number >>> 28) & 0x0F : byte));
  const floatBits = (value) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    return view.getUint32(0);
  };
  const keyBits = (key) => ((key.charCodeAt(0) << 24) | (key.charCodeAt(1) << 16) | (key.charCodeAt(2) << 8) | key.charCodeAt(3)) >>> 0;
  const records = Object.entries(values).map(([key, value]) => [...seven(keyBits(key)), ...seven(floatBits(value))]);
  const chunks = [];
  for (let at = 0; at < records.length; at += perMessage) chunks.push(records.slice(at, at + perMessage).flat());
  const nameBytes = [0x07, 0x04, ...Array.from({ length: 24 }, (_, index) => name.charCodeAt(index) || 0)];
  return chunks.map((data, index) => {
    const body = [0x3E, 0x2F, 0x00, 0x10, 0x03, chunks.length, index + 1, ...(index === 0 ? nameBytes : []), ...data];
    const sum = body.reduce((total, byte) => total + byte, 0) & 0x7F;
    return [0xF0, ...body, sum, 0xF7];
  });
}

// A pretend Protein: what each controller value does to its sound, including one setting
// whose real name differs from the page's guess, and stepped settings with their own sizes.
const REAL_NAMES = { ...ProteinDump.GUESSES, "amp.volume": "zzv1" };
const STEPS = { "osc1.table": 30, "osc2.table": 30, "osc1.wave": 64, "osc2.wave": 64, "osc1.semitone": 49, "osc2.semitone": 49, "lfo1.shape": 7, "lfo2.shape": 7, "lfo1.ratio": 20, "lfo2.ratio": 20 };

function protein(start) {
  const values = { ...start };
  return {
    values,
    set(id, cc) {
      if (id === "fx1.amount" || id === "fx2.amount") {
        const prefix = ProteinDump.FX_PREFIXES[values[`fxt${id[2]}`] - 1];
        values[`${prefix}dw`] = cc / 127;
      } else if (STEPS[id]) {
        values[REAL_NAMES[id]] = Math.floor((cc * STEPS[id]) / 128);
      } else {
        values[REAL_NAMES[id]] = cc / 127;
      }
    },
  };
}

function startingSound() {
  const values = { fxt1: 1, fxt2: 5, chdw: 0.6, drdw: 0.3, fldw: 0.5, other1: 0.25, dty1: 0 };
  for (const [id, key] of Object.entries(REAL_NAMES)) values[key] = ProteinDump.STEPPED.has(id) ? 3 : 0.5;
  return values;
}

test("a dump's messages are read into its name and settings", () => {
  const dump = ProteinDump.parse(encode("Soft Dist", { fcu1: 1, aed1: 22 / 127, w1p1: 8, flav: 0.875 }, 2));
  assert.equal(dump.name, "Soft Dist");
  assert.equal(dump.values.fcu1, 1);
  assert.equal(dump.values.w1p1, 8);
  assert.ok(Math.abs(dump.values.aed1 - 22 / 127) < 1e-6);
  assert.ok(Math.abs(dump.values.flav - 0.875) < 1e-6);
});

test("damaged, partial or unrelated dumps are refused", () => {
  const good = encode("A", { fcu1: 1, fre1: 0 }, 1);
  const damaged = good.map((message) => [...message]);
  damaged[1][damaged[1].length - 3] ^= 1;
  assert.throws(() => ProteinDump.parse(damaged), /damaged/);
  assert.throws(() => ProteinDump.parse(good.slice(0, 1)), /Only 1 of its 2/);
  assert.throws(() => ProteinDump.parse([[0xF0, 0x41, 0x10, 0x00, 0x10, 1, 1, 1, 0, 0xF7]]), /isn't a Protein/);
  assert.throws(() => ProteinDump.parse([]), /Nothing arrived/);
});

test("teaching finds every setting, including a wrong guess, and reading gives back what was set", () => {
  const ids = Object.keys(ProteinDump.GUESSES).concat(["fx1.amount", "fx2.amount"]);
  const synth = protein(startingSound());
  const before = ProteinDump.parse(encode("Before", synth.values)).values;
  const sent = ProteinDump.teachValues(ids);
  assert.equal(new Set(Object.values(sent).filter((cc) => cc !== 127)).size, ids.length - ProteinDump.STEPPED.size, "smooth settings get their own values");
  for (const [id, cc] of Object.entries(sent)) synth.set(id, cc);
  const after = ProteinDump.parse(encode("After", synth.values)).values;

  const { map, fx, problems } = ProteinDump.learn(sent, before, after);
  assert.deepEqual(problems, []);
  assert.equal(map["amp.volume"].key, "zzv1");
  assert.equal(map["osc1.table"].steps, 30);
  assert.equal(map["lfo1.shape"].steps, 7);
  assert.deepEqual(fx.types, { 1: "ch", 5: "dr" });

  // Any sound read back gives the controller values that would select it.
  const chosen = { "filter.cutoff": 90, "ampEnv.decay": 22, "amp.volume": 101, "osc1.table": 70, "lfo1.shape": 40, "fx1.amount": 33, "fx2.amount": 12 };
  for (const [id, cc] of Object.entries(chosen)) synth.set(id, cc);
  const read = ProteinDump.read(ProteinDump.parse(encode("Read", synth.values)).values, map, fx);
  for (const id of ["filter.cutoff", "ampEnv.decay", "amp.volume", "fx1.amount", "fx2.amount"]) assert.equal(read[id], chosen[id], id);
  // A stepped setting comes back as a value that selects the same step.
  for (const id of ["osc1.table", "lfo1.shape"]) {
    assert.equal(Math.floor((read[id] * STEPS[id]) / 128), Math.floor((chosen[id] * STEPS[id]) / 128), id);
  }
});

test("an effect amount follows the effect type in its slot", () => {
  const map = {};
  const fx = { taught: ["fx1.amount"], types: { 1: "ch" } };
  assert.equal(ProteinDump.read({ fxt1: 1, chdw: 0.5 }, map, fx)["fx1.amount"], 64);
  // Types not seen while teaching use the manual's order.
  assert.equal(ProteinDump.read({ fxt1: 9, rvdw: 1 }, map, fx)["fx1.amount"], 127);
});

test("stepped values come back in the middle of their range", () => {
  assert.equal(ProteinDump.steppedCc(0, 2), 32);
  assert.equal(ProteinDump.steppedCc(1, 2), 96);
  for (const steps of [7, 20, 30, 49, 64]) {
    for (let index = 0; index < steps; index += 1) {
      assert.equal(Math.floor((ProteinDump.steppedCc(index, steps) * steps) / 128), index, `${index} of ${steps}`);
    }
  }
});
