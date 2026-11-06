"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const SoundFolder = require("../folder.js");

// A folder in memory that behaves like the one Chrome hands over.
function fakeFolder() {
  const entries = new Map();
  const fileHandle = (name) => ({
    kind: "file",
    getFile: async () => {
      const bytes = entries.get(name);
      return { lastModified: 0, arrayBuffer: async () => bytes.buffer.slice(0), text: async () => new TextDecoder().decode(bytes) };
    },
    createWritable: async () => {
      let written = new Uint8Array();
      return { write: async (bytes) => { written = new Uint8Array(bytes); }, close: async () => { entries.set(name, written); } };
    },
  });
  const folder = {
    getFileHandle: async (name, { create } = {}) => {
      if (!entries.has(name)) {
        if (!create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        entries.set(name, new Uint8Array());
      }
      return entries.get(name) instanceof Uint8Array ? fileHandle(name) : entries.get(name);
    },
    getDirectoryHandle: async (name, { create } = {}) => {
      if (!entries.has(name)) {
        if (!create) throw new Error("missing");
        entries.set(name, fakeFolder());
      }
      return entries.get(name);
    },
    removeEntry: async (name) => {
      if (!entries.delete(name)) throw new Error("missing");
    },
  };
  folder.entries = async function* list() {
    for (const [name, value] of entries) yield [name, value instanceof Uint8Array ? fileHandle(name) : { ...value, kind: "directory" }];
  };
  folder.files = entries;
  return folder;
}

const sound = (fill) => new Uint8Array([0xF0, fill, 0xF7]);
const check = (bytes) => {
  if (bytes[0] !== 0xF0) throw new Error("not a sound");
};

async function readyLibrary() {
  const library = SoundFolder.create({ db: "test", check });
  library.folder = fakeFolder();
  await library.refresh();
  return library;
}

test("names are made safe for files, and taken ones get a number", () => {
  assert.equal(SoundFolder.cleanName(' Acid/Bass: "1" '), "Acid Bass 1");
  assert.equal(SoundFolder.cleanName("..hidden"), "hidden");
  assert.equal(SoundFolder.cleanName("x".repeat(80)).length, 60);
  assert.equal(SoundFolder.uniqueName("Pad", ["pad", "Pad 2"]), "Pad 3");
  assert.equal(SoundFolder.uniqueName("Lead", ["Pad"]), "Lead");
});

test("sounds are saved as files, renamed and deleted, with their details kept beside them", async () => {
  const library = await readyLibrary();
  assert.equal(library.status, "ready");
  assert.equal(await library.add("Wobble", sound(1), { from: "Patch 3" }), "Wobble");
  assert.equal(await library.add("Wobble", sound(2)), "Wobble 2");
  assert.ok(library.folder.files.has("Wobble.syx") && library.folder.files.has("Wobble 2.syx"));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(library.folder.files.get("library-info.json"))), { Wobble: { from: "Patch 3" } });

  const [first] = library.items;
  assert.equal(await library.rename(first, "Deep: Wobble"), "Deep Wobble");
  assert.ok(!library.folder.files.has("Wobble.syx"));
  assert.deepEqual([...library.folder.files.get("Deep Wobble.syx")], [0xF0, 1, 0xF7]);
  assert.deepEqual(library.info, { "Deep Wobble": { from: "Patch 3" } });

  await library.remove(first);
  assert.ok(!library.folder.files.has("Deep Wobble.syx"));
  assert.deepEqual(library.info, {});
  assert.deepEqual(library.items.map((item) => item.name), ["Wobble 2"]);
});

test("reading the folder skips files that aren't sounds", async () => {
  const library = await readyLibrary();
  library.folder.files.set("Good.syx", sound(4));
  library.folder.files.set("Broken.syx", new Uint8Array([1, 2, 3]));
  library.folder.files.set("notes.txt", new Uint8Array([0xF0]));
  await library.refresh();
  assert.deepEqual(library.items.map((item) => item.name), ["Good"]);
  assert.equal(library.skipped, 1);
});

test("a folder inside the library holds its own files", async () => {
  const library = await readyLibrary();
  const backups = await library.subfolder("Backups");
  await backups.write("Backup 1", sound(9));
  assert.deepEqual((await backups.list()).map((file) => file.name), ["Backup 1"]);
  await library.refresh();
  assert.equal(library.items.length, 0, "the library's own list leaves the folder out");
  await backups.remove("Backup 1");
  assert.deepEqual(await backups.list(), []);
});
