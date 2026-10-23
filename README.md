# klipper-toolchanger-ui

A tool-changer page that sits next to Mainsail, plus Klipper macros that make
tool-change failures recoverable. Built for a Voron 2.4 StealthChanger running
[klipper-toolchanger-easy](https://github.com/jwellman80/klipper-toolchanger-easy)
with per-tool OptoTap probes, but nothing is specific to one printer.

Open it at `http://<printer>/toolchanger/`, or from **Tool Changer** in Mainsail's sidebar.

## What it does

**Safe failures (Klipper side, `klipper/toolchanger-safety.cfg`)**
- A failed pickup no longer runs `M112`. The stock `_STOP_IF_INCORRECT_TOOL`
  emergency-stopped Klipper, which forced a restart, re-home and QGL (and its
  `T in params` check never ran). Now the toolchanger goes into its error state,
  the carriage backs out of the dock along the dock path, the printer **stays
  homed**, and a print is paused instead of killed.
- Tool-drop crash detection no longer runs `M84` (homing is kept; hotends are
  turned off and the print pauses).
- An empty carriage is allowed (`require_tool_present: False`), so
  `TC_RETRY_PICKUP T=n` can recover without a restart.
- `RESUME` re-detects the tool, then runs Mainsail's normal resume. The stock
  toolchanger `RESUME` skipped Mainsail's un-retract and temperature restore.
- `TOOL_ALIGN_*` fixed: works with docks at Y > 0, enters docking mode, uses
  real toolhead coordinates, leaves the dock along the pickup path before testing.

| Command | |
|---|---|
| `TC_RECOVER` | Re-detect the tool on the carriage and clear the error (no motion) |
| `TC_RETRY_PICKUP T=n` | Recover, then pick up tool n |
| `TC_BACK_OUT T=n` | Leave tool n's dock the way a dropoff does (only moves if inside it) |
| `TC_TEST_MODE ENABLE=1 [SPEED=0.35]` | Slow dock moves; failures report-only |
| `TC_TEST_DOCK T=n CYCLES=k` | Dock/pick up tool n k times, verifying each pickup |
| `TC_CLEAR_ACTIVE_TOOL` | Forget the active tool without moving (Python helper) |

**Web page (`web/`)**
- **Tools**: every tool with dock position, offsets, nozzle, probe offset,
  input shaper, CAN/USB board and firmware, live temps, and sanity warnings
  (e.g. dock positions outside the axis range).
- **Edit**: change any of those. Values are written to the file Klipper reads
  them from (following `[include]` order), comments are kept, a backup goes to
  `config/toolchanger-ui-backups/`, and the value is applied live where Klipper
  allows (dock position, offsets, pressure advance, rotation distance, shaper).
- **Dock test & align**: pre-flight checks, test mode, repeated dock cycles
  with pass/fail counters, guided alignment with a fine jog pad, save the new
  dock position without restarting.
- **Slicer check**: scans a G-code file for commands this Klipper does not
  have and checks the OrcaSlicer profile embedded in it (single-nozzle
  multi-material mode, nozzle sizes per tool, extruder offsets, PRINT_START
  parameters). Also checks pasted start/tool-change G-code.
- **Boards & IDs**: all MCUs with CAN UUID / USB serial and firmware, and a
  scan for unassigned CAN boards and USB serial devices.
- **Recovery banner** on every tab when a tool change fails: probe states,
  re-detect, back out, retry pickup, resume or cancel.

## Install

On the printer (as `pi`):

```bash
git clone <this repo> ~/klipper-toolchanger-ui
~/klipper-toolchanger-ui/deploy/install-on-printer.sh
sudo systemctl restart klipper
```

The built web app is committed in `web/dist`, so the printer needs no Node.

## Develop

```bash
cd web
npm install
npm run dev     # http://localhost:5180/toolchanger/ proxied to $PRINTER_URL (default http://voron.local)
npm test        # config editor + G-code checker unit tests
```

`deploy/deploy.sh` builds and pushes to a printer over SSH (see the header for
usage). The Moonraker client, config editor, tool model and G-code checker in
`web/src/lib/` have no Vue dependency, so they can move into a Mainsail fork later.
