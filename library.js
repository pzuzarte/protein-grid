"use strict";
/* Whole Protein sounds for the library: each is the dump the Protein sent from Presets,
   Actions, Send, kept byte for byte so it can be exported or sent back. A dump is several
   SysEx messages, each holding its count at byte 6 and its number, from 1, at byte 7.
   Files can hold several dumps one after another. */
const ProteinLibrary = (() => {
  const HEADER = [0xF0, 0x3E, 0x2F];
  const isDumpMessage = (message) => message.length > 9 && HEADER.every((byte, index) => message[index] === byte)
    && message[4] === 0x10 && message.at(-1) === 0xF7;

  // Every SysEx message in a run of bytes.
  function messages(bytes) {
    const found = [];
    let start = -1;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0xF0) start = index;
      else if (bytes[index] === 0xF7 && start >= 0) {
        found.push(Array.from(bytes.slice(start, index + 1)));
        start = -1;
      }
    }
    return found;
  }

  // The complete dumps in a file, as lists of messages. Partial ones are left out.
  function split(bytes) {
    const dumps = [];
    let current = null;
    for (const message of messages(bytes)) {
      if (!isDumpMessage(message)) continue;
      const [count, number] = [message[6], message[7]];
      if (number === 1) current = { count, list: [] };
      if (!current || count !== current.count || number !== current.list.length + 1) {
        current = null;
        continue;
      }
      current.list.push(message);
      if (current.list.length === count) {
        dumps.push(current.list);
        current = null;
      }
    }
    return dumps;
  }

  // A dump as text for storing in the browser, and back.
  function toText(dump) {
    let text = "";
    for (const byte of dump.flat()) text += String.fromCharCode(byte);
    return btoa(text);
  }

  function fromText(text) {
    let bytes;
    try {
      bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
    } catch (error) {
      throw new Error("It has a damaged sound.");
    }
    const [dump, ...rest] = split(bytes);
    if (!dump || rest.length) throw new Error("It has a damaged sound.");
    return dump;
  }

  return { fromText, messages, split, toText };
})();

if (typeof module !== "undefined") module.exports = ProteinLibrary;
