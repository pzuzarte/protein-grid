"use strict";
/* A sound library kept as files in a folder on this computer, which the browser is
   allowed to use. Each sound is its own file, named after the sound, and a small info
   file beside them keeps where each came from. Chrome remembers the folder, and may ask
   to allow it again after a restart. The same file is used by Bass Station Grid and
   Protein Grid. */
const SoundFolder = (() => {
  const INFO = "library-info.json";
  const HANDLE_STORE = "kv";
  const HANDLE_KEY = "library-folder";

  // A name that's safe as a file name everywhere: no slashes, colons or the like.
  const cleanName = (raw) => String(raw ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^\.+/, "").slice(0, 60).trim();

  // The name, or the name with a number after it if that's taken.
  function uniqueName(name, taken) {
    const used = new Set([...taken].map((other) => other.toLowerCase()));
    let candidate = name;
    for (let number = 2; used.has(candidate.toLowerCase()); number += 1) candidate = `${name} ${number}`;
    return candidate;
  }

  async function listFiles(directory, extension) {
    const files = [];
    for await (const [fileName, handle] of directory.entries()) {
      if (handle.kind !== "file" || fileName.startsWith(".")) continue;
      if (!fileName.toLowerCase().endsWith(extension)) continue;
      const file = await handle.getFile();
      files.push({ name: fileName.slice(0, -extension.length), bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  }

  async function writeFile(directory, fileName, bytes) {
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(bytes));
    await writable.close();
  }

  function handleStore(db, action, mode) {
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open(db, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore(HANDLE_STORE);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const request = action(opening.result.transaction(HANDLE_STORE, mode).objectStore(HANDLE_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      };
    });
  }

  /* db names where the folder choice is remembered, extension is the files' ending, and
     check(bytes) throws if a file isn't a sound. status is one of none, permission,
     missing, ready and unsupported. */
  function create({ db, extension = ".syx", check }) {
    const library = { folder: null, status: "none", items: [], info: {}, skipped: 0 };

    library.supported = () => typeof window !== "undefined" && Boolean(window.showDirectoryPicker);

    library.refresh = async () => {
      try {
        const files = await listFiles(library.folder, extension);
        library.items = [];
        library.skipped = 0;
        for (const file of files) {
          try {
            check(file.bytes);
            library.items.push(file);
          } catch {
            library.skipped += 1;
          }
        }
        library.info = await library.readInfo();
        library.status = "ready";
      } catch {
        library.status = "missing";
        library.items = [];
      }
    };

    library.readInfo = async () => {
      try {
        const file = await (await library.folder.getFileHandle(INFO)).getFile();
        const info = JSON.parse(await file.text());
        return info && typeof info === "object" ? info : {};
      } catch {
        return {};
      }
    };

    library.saveInfo = () => writeFile(library.folder, INFO, new TextEncoder().encode(JSON.stringify(library.info, null, 2)));

    // Reconnects to the folder chosen last time, if Chrome still allows it.
    library.restore = async () => {
      if (!library.supported()) {
        library.status = "unsupported";
        return;
      }
      try {
        library.folder = (await handleStore(db, (store) => store.get(HANDLE_KEY), "readonly")) || null;
      } catch {
        library.folder = null;
      }
      if (!library.folder) {
        library.status = "none";
        return;
      }
      if (await library.folder.queryPermission({ mode: "readwrite" }) === "granted") await library.refresh();
      else library.status = "permission";
    };

    // Allows the remembered folder again, or asks for one. Returns false if cancelled.
    library.choose = async ({ another = false } = {}) => {
      if (library.status === "permission" && !another) {
        if (await library.folder.requestPermission({ mode: "readwrite" }) !== "granted") return false;
      } else {
        try {
          library.folder = await window.showDirectoryPicker({ id: db, mode: "readwrite" });
        } catch (error) {
          if (error.name === "AbortError") return false;
          throw error;
        }
        await handleStore(db, (store) => store.put(library.folder, HANDLE_KEY), "readwrite");
      }
      await library.refresh();
      return true;
    };

    const taken = () => library.items.map((item) => item.name);

    // Saves a new sound under a free name, and returns the name used.
    library.add = async (name, bytes, details = {}) => {
      const fileName = uniqueName(cleanName(name) || "Sound", taken());
      await writeFile(library.folder, `${fileName}${extension}`, bytes);
      library.items.push({ name: fileName, bytes: new Uint8Array(bytes), modified: Date.now() });
      library.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      if (Object.keys(details).length) {
        library.info[fileName] = details;
        await library.saveInfo();
      }
      return fileName;
    };

    library.rename = async (item, name) => {
      const clean = cleanName(name);
      if (!clean || clean === item.name) return item.name;
      const fileName = uniqueName(clean, taken().filter((other) => other !== item.name));
      await writeFile(library.folder, `${fileName}${extension}`, item.bytes);
      await library.folder.removeEntry(`${item.name}${extension}`);
      if (library.info[item.name]) {
        library.info[fileName] = library.info[item.name];
        delete library.info[item.name];
        await library.saveInfo();
      }
      item.name = fileName;
      return fileName;
    };

    library.remove = async (item) => {
      await library.folder.removeEntry(`${item.name}${extension}`);
      library.items = library.items.filter((other) => other !== item);
      if (library.info[item.name]) {
        delete library.info[item.name];
        await library.saveInfo();
      }
    };

    // Files in a folder inside the library, such as backups.
    library.subfolder = async (name) => {
      const directory = await library.folder.getDirectoryHandle(name, { create: true });
      return {
        list: () => listFiles(directory, extension),
        write: (fileName, bytes) => writeFile(directory, `${fileName}${extension}`, bytes),
        remove: (fileName) => directory.removeEntry(`${fileName}${extension}`),
      };
    };

    return library;
  }

  return { cleanName, create, uniqueName };
})();

if (typeof module !== "undefined") module.exports = SoundFolder;
