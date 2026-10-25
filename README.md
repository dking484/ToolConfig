# ToolConfig

A tool-changer page that sits next to Mainsail, plus Klipper macros that make
tool-change failures recoverable. Works with
[klipper-toolchanger-easy](https://github.com/jwellman80/klipper-toolchanger-easy)
and with the regular [klipper-toolchanger](https://github.com/viesturz/klipper-toolchanger)
(see [Compatibility](#compatibility)). Built on a Voron 2.4 StealthChanger with
per-tool OptoTap probes, but nothing is specific to one printer.

Open it at `http://<printer>/toolconfig/`, or from **ToolConfig** in Mainsail's sidebar.

## Compatibility

| | klipper-toolchanger-easy | klipper-toolchanger (viesturz) |
|---|---|---|
| Web page, tool editor, dock test & align, slicer check | Yes | Yes |
| Safe failures, test mode, recovery commands | Yes | Yes |
| Live "on gantry / in dock" sensor states | Per-tool probes | Per-tool probes (`[tool_probe_endstop]` setup) or `detection_pin` |
| Failed-pickup detection | `VERIFY_TOOL_DETECTED` + probes | `VERIFY_TOOL_DETECTED`, needs `detection_pin` on every tool |
| `M112` on a failed pickup replaced | Yes (easy's `_STOP_IF_INCORRECT_TOOL`) | Not needed: upstream never runs `M112` |
| Install script adds the `[include]` | Yes | Prints where to add it |
| Tested on real hardware | Yes | Checked against the code (upstream `94756df`, April 2026), not run on a printer yet |

How it copes with the differences:
- **Tool sensors.** easy's probes carry `tool`, upstream's carry `tool_number`.
  Upstream can also own the probes inside `[toolchanger]` (`tool_probe:` in each
  `[tool]`), with no `[tool_probe_endstop]` object and no
  `DETECT_ACTIVE_TOOL_PROBE` command. `toolchanger_ui.py` reads whichever setup
  is there and publishes one view (`printer.toolchanger_ui.probes`,
  `detected_tool`, `sensors`). `TC_DETECT` reads the sensors on any setup.
- **Crash handling.** The tool-drop `crash_gcode` is set from Python rather
  than a `[tool_probe_endstop]` section, which would clash with upstream's
  toolchanger-owned probes. Upstream doesn't do tool-drop crash detection in
  that setup yet.
- **RESUME** runs Mainsail's resume when `mainsail.cfg` is included, otherwise
  plain `RESUME_BASE`.
- **Upstream and Klipper versions.** Upstream's `tool_probe.py` (as of
  `94756df`) calls Klipper's probe helpers with the older signatures. On
  Klipper v0.13.0-816 (October 2026) those take different arguments, so
  upstream's per-tool probes need a Klipper version upstream supports.
  klipper-toolchanger-easy already tracks the newer API. This is between
  upstream and Klipper; ToolConfig doesn't change it.
- **Printers without tool sensors** still get everything except the sensor
  views; the "is there a tool on the gantry?" check before homing is skipped.

Easy's own macros that ToolConfig replaces (`_STOP_IF_INCORRECT_TOOL`,
`_INITIALIZE_FROM_DETECTED_TOOL_IMPL`) are simply unused on upstream.

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
- Probe heat is turned back off. easy's `_TAP_PROBE_ACTIVATE` heats the nozzle
  to 150 °C before each Tap probe and leaves it on, so outside a print a tool
  stayed hot until the 30-minute idle timeout (and could be docked hot). Now
  heat that only probing turned on goes off 2 minutes after homing/QGL finish
  (`probe_heat_off_delay` under `[toolchanger_ui]`). Never during a print, and
  a temperature you set yourself is left alone.
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
- **Edit a tool's whole config**: a **Visual editor**
  with a card per section (board, extruder, driver, fans, LEDs, tool, probe,
  accelerometer, macro; unknown keys too) and a **Code editor** with the raw
  `Tn.cfg`. Both edit the same text. Save shows the changes, backs the file up,
  applies dock position / offsets / shaper / pressure advance / rotation
  distance live, and flags anything that needs a restart.
- **Add a tool**: copies an existing tool's file and renumbers everything
  (board, extruder, fans, LEDs, macro, probe, accelerometer), sets the CAN UUID
  (scan) or USB serial, nozzle, thermistor, max temp, and leaves the dock
  position invalid until it is taught. Review it in the editor before creating;
  "decide later" creates it disabled.
- **Disable / enable tools**: files move to/from `toolchanger/tools-disabled/`.
  If Klipper won't start after a change, **Undo the last ToolConfig change**
  restores the previous files and restarts.
- **Quick edits**: change any of those. Values are written to the file Klipper reads
  them from (following `[include]` order), comments are kept, a backup goes to
  `config/toolconfig-backups/`, and the value is applied live where Klipper
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
- **Matches Mainsail's theme**: dark/light mode, primary color, logo color,
  theme preset logo (or your `.theme/sidebar-logo.*`), read from Mainsail's
  settings in Moonraker (re-checked on focus and every minute). Status colors
  and the emergency stop stay fixed; `.theme/custom.css` is not applied (it
  targets Mainsail's own page).
- **Recovery banner** on every tab when a tool change fails: probe states,
  re-detect, back out, retry pickup, resume or cancel.

## Install

On the printer (as `pi`):

```bash
git clone https://github.com/dking484/ToolConfig.git ~/ToolConfig
~/ToolConfig/deploy/install-on-printer.sh
sudo systemctl restart klipper
```

The built web app is committed in `web/dist`, so the printer needs no Node.
Released versions are listed under
[Releases](https://github.com/dking484/ToolConfig/releases); to install one,
add `--branch v0.1.0` (or the version you want) to the `git clone`. Each
release also has a zip, but use the clone if you want Mainsail updates (below).

With **klipper-toolchanger** (viesturz), the script prints where to add the
include instead: put `[include toolchanger/toolchanger-safety.cfg]` in
`printer.cfg` *after* your toolchanger and tool configs.

### Updates from Mainsail (Moonraker update manager)

ToolConfig isn't a Mainsail plugin. Mainsail's **Update Manager** panel (Machine
page) lists whatever Moonraker's update manager tracks, so add ToolConfig there.
In `moonraker.conf`:

```ini
[update_manager ToolConfig]
type: git_repo
path: ~/ToolConfig
origin: https://github.com/dking484/ToolConfig.git
primary_branch: main
channel: stable
managed_services: klipper
```

`channel: stable` offers only released versions (tags like `v0.1.0`). Leave it
out to get every change on `main` as soon as it is pushed (less tested).

Restart Moonraker (`sudo systemctl restart moonraker`); ToolConfig then shows up
next to Klipper and Mainsail with an **Update** button. An update brings the
clone up to date (to the newest release on `stable`) and restarts Klipper. The
web page, macros and Python module are served or linked straight from
`~/ToolConfig`, so nothing else needs reinstalling. Only
update while the printer is idle, since Klipper restarts and loses homing.

- `~/ToolConfig` has to be the `git clone` from above. Moonraker flags a copied
  folder or local edits as invalid or dirty.
- Re-run `deploy/install-on-printer.sh` only if the release notes say so (for
  example, a change to the nginx snippet).

## Develop

```bash
cd web
npm install
npm run dev     # http://localhost:5180/toolconfig/ proxied to $PRINTER_URL (default http://voron.local)
npm test        # config editor + G-code checker unit tests
```

`deploy/deploy.sh` builds and pushes to a printer over SSH (see the header for
usage). The Moonraker client, config editor, tool model and G-code checker in
`web/src/lib/` have no Vue dependency, so they can move into a Mainsail fork later.
