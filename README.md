# Protein Grid

A pattern grid and sound editor for the Waldorf Protein, in the browser. It's unofficial and not affiliated with Waldorf.

It has two tabs:

- **Grid**: a key-locked note grid with 16 patterns, Generate, chains, sub-steps, knob movements, and MIDI file import and export. It plays the Protein over USB MIDI, and can play together with S-1 Grid and MPC Grid when they're open in the same browser.
- **Synth**: sliders for 52 of the Protein's sound settings, saved sounds, and Vary.

## Mapping

The Protein has no fixed MIDI controller numbers for its settings. Each one is mapped on the synth with Shift + Settings, Map CC, which maps the last edited setting to the next controller it receives. **Set up controls** on the Synth tab walks through them one at a time and sends a free controller number for each. Mappings are kept in the browser and in backups.

## Requirements

A current Chrome or Edge on a computer, for Web MIDI.

## Running it

It's a static page with no build step. Serve the folder and open it:

```bash
python3 -m http.server 8776
```

## Tests

```bash
node --test "test/*.test.js"
```
