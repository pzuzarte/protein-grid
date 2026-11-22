"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ProteinLibrary = require("../library.js");
const ProteinDump = require("../dump.js");

// A dump the way the Protein sends one: a name, then settings over several messages.
function dump(name, count) {
  return Array.from({ length: count }, (_, index) => {
    const nameBytes = index === 0 ? [0x07, 0x04, ...Array.from({ length: 24 }, (_, at) => name.charCodeAt(at) || 0)] : [];
    const body = [0x3E, 0x2F, 0x00, 0x10, 0x03, count, index + 1, ...nameBytes, 0x06, 0x0C, 0x6B, 0x15, 0x31, 0x03, 0x7C, 0x00, 0x00, 0x00];
    const sum = body.reduce((total, byte) => total + byte, 0) & 0x7F;
    return [0xF0, ...body, sum, 0xF7];
  });
}

test("a file of several dumps splits into them, skipping anything else", () => {
  const other = [0xF0, 0x41, 0x10, 0x42, 0xF7];
  const first = dump("Soft Dist", 3);
  const second = dump("Glass", 2);
  const found = ProteinLibrary.split(new Uint8Array([...first.flat(), ...other, 0x00, ...second.flat()]));
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], first);
  assert.equal(ProteinDump.parse(found[1]).name, "Glass");
});

test("a dump missing a message is left out", () => {
  const broken = dump("Broken", 3);
  broken.splice(1, 1);
  const whole = dump("Whole", 2);
  const found = ProteinLibrary.split(new Uint8Array([...broken.flat(), ...whole.flat()]));
  assert.equal(found.length, 1);
  assert.equal(ProteinDump.parse(found[0]).name, "Whole");
});

test("capturing gathers one sound after another, and notices one that broke", () => {
  const take = ProteinLibrary.collector();
  const results = (messages) => messages.map((message) => take.add(message));
  const first = dump("Soft Dist", 3);
  const second = dump("Glass", 2);
  let seen = results(first);
  assert.deepEqual(seen.map((item) => Boolean(item.dump)), [false, false, true]);
  assert.deepEqual(seen[2].dump, first);
  assert.equal(take.pending(), false);
  // Something else on the way is ignored.
  assert.deepEqual(take.add([0xF0, 0x41, 0x10, 0x42, 0xF7]), { broken: false });
  // A message goes missing: that sound is broken, and the next one still arrives whole.
  const broken = dump("Broken", 3);
  seen = results([broken[0], broken[2]]);
  assert.equal(seen[1].broken, true);
  seen = results(second);
  assert.equal(ProteinDump.parse(seen[1].dump).name, "Glass");
  // A new sound starting before the last finished means the last one broke.
  results([broken[0], broken[1]]);
  assert.equal(take.pending(), true);
  seen = results(second);
  assert.equal(seen[0].broken, true);
  assert.deepEqual(seen[1].dump, second);
  take.add(broken[0]);
  take.reset();
  assert.equal(take.pending(), false);
});
