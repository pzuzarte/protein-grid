"use strict";
/* Whole Protein sounds for the library: each is the dump the Protein sent from Presets,
   Actions, Send, kept byte for byte in its own file so it can be sent back. A dump is several
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

  /* Gathers dumps as their messages arrive, for capturing one sound after another.
     add(message) gives { dump } when the message completes one, and broken: true when a
     dump's messages came out of order or one went missing, so that sound needs sending
     again. Messages that aren't part of a dump are ignored. */
  function collector() {
    let current = null;
    return {
      add(message) {
        if (!isDumpMessage(message)) return { broken: false, other: true };
        const [count, number] = [message[6], message[7]];
        let broken = false;
        if (number === 1) {
          broken = Boolean(current);
          current = { count, list: [] };
        } else if (!current || count !== current.count || number !== current.list.length + 1) {
          current = null;
          return { broken: true };
        }
        current.list.push(message);
        if (current.list.length < count) return { broken };
        const dump = current.list;
        current = null;
        return { dump, broken };
      },
      pending: () => Boolean(current),
      reset() {
        current = null;
      },
    };
  }

  return { collector, messages, split };
})();

if (typeof module !== "undefined") module.exports = ProteinLibrary;
