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

test("sounds survive being stored as text, and damaged text is refused", () => {
  const original = dump("Keep", 4);
  assert.deepEqual(ProteinLibrary.fromText(ProteinLibrary.toText(original)), original);
  assert.throws(() => ProteinLibrary.fromText("not base64!"), /damaged sound/);
  assert.throws(() => ProteinLibrary.fromText(ProteinLibrary.toText(original.slice(0, 2))), /damaged sound/);
});
