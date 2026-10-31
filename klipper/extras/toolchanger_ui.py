# Helpers for ToolConfig
#
# Adds what the macros in toolchanger-safety.cfg cannot do on their own:
#  - TC_CLEAR_ACTIVE_TOOL: forget the "active" tool without any motion, used
#    after a failed pickup left the toolchanger pointing at a tool that is
#    not actually on the carriage.
#  - TC_DETECT: read every tool sensor now, whichever kind the printer has.
#  - Auto-select: a tool put on the empty gantry by hand is selected once its
#    sensor has settled (outside prints and tool changes; no motion).
#  - Probe heat cooldown: easy's _TAP_PROBE_ACTIVATE heats the nozzle to
#    150C before every Tap probe and never turns it off, so outside a print a
#    tool stays hot until idle_timeout. Heat it only turned on is turned back
#    off probe_heat_off_delay seconds after probing ends.
#  - TC_MEASURE_Z: probe one bed spot with every tool's own Tap probe and
#    propose each tool's probe z_offset and gcode_z_offset from it;
#    TC_SET_Z_OFFSET applies them live (the web page also saves them).
#  - printer.toolchanger_ui status: the toolchanger's error message, which
#    klipper-toolchanger does not publish itself, and one view of the tool
#    sensors for the macros and the web page.
#
# Works with klipper-toolchanger-easy and with viesturz/klipper-toolchanger.
# They report tool sensors differently:
#  - a [tool_probe_endstop] object with per-tool [tool_probe] sections
#    (easy, and upstream's older setup): probes carry `tool` (easy) or
#    `tool_number` (upstream);
#  - upstream's newer setup: `tool_probe:` / `detection_pin:` in each [tool],
#    the probe endstop lives inside the toolchanger and presence comes from
#    the tool's detect_state.
#
# This file may be distributed under the terms of the GNU GPLv3 license.

import sys, time

# Seconds a tool's sensor must be steady before a hand-placed tool is selected
AUTO_SELECT_SETTLE = 1.5
# Two probes of one tool further apart than this are reported as unsteady
Z_MEASURE_SPREAD = 0.02


def _probe_tool_number(probe):
    n = getattr(probe, 'tool_number', None)
    if n is None:
        n = getattr(probe, 'tool', None)
    return n


def z_proposals(triggers, ref, ref_gcode_z):
    """Proposed offsets from the trigger heights one bed spot gave each tool.

    triggers: tool number -> toolhead Z where its probe triggered, all
    measured right after homing Z with the reference tool. Homing with a tool
    sets Z to its probe's z_offset at the trigger, so a tool whose z_offset
    is its measured trigger height homes to the same Z as the reference.
    The nozzles' length difference is the difference of trigger heights,
    assuming the Tap sensors press in about the same amount before they
    trigger; the first layer shows what is left. The reference keeps its
    offsets: it defines Z.
    Returns tool number -> (probe z_offset, gcode_z_offset)."""
    base = triggers[ref]
    return {n: (round(z, 3), round(ref_gcode_z + z - base, 3))
            for n, z in triggers.items() if n != ref}


class ToolchangerUI:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.gcode = self.printer.lookup_object('gcode')
        self.toolchanger = None
        self.printer.register_event_handler('klippy:connect',
                                            self._handle_connect)
        self.printer.register_event_handler('klippy:ready',
                                            self._handle_ready)
        self.reactor = self.printer.get_reactor()
        # heater name -> target that _TAP_PROBE_ACTIVATE set on a cold heater
        self.probe_heated = {}
        self.probe_heat_off_delay = config.getfloat(
            'probe_heat_off_delay', 120., minval=0.)
        self.probe_heat_wait = False
        self.probe_heat_timer = self.reactor.register_timer(
            self._probe_heat_timer)
        # Probing (and homing) moves: a Tap sensor pressed by the bed then
        # reads the same as a docked tool, so the UI should not alarm.
        self.homing_move_active = False
        self.homing_move_end_time = -99.
        self.printer.register_event_handler('homing:homing_move_begin',
                                            self._homing_move_begin)
        self.printer.register_event_handler('homing:homing_move_end',
                                            self._homing_move_end)
        self.printer.register_event_handler('gcode:command_error',
                                            self._homing_move_end)
        self.gcode.register_command(
            'TC_CLEAR_ACTIVE_TOOL', self.cmd_TC_CLEAR_ACTIVE_TOOL,
            desc=self.cmd_TC_CLEAR_ACTIVE_TOOL_help)
        self.gcode.register_command(
            'TC_RAISE', self.cmd_TC_RAISE, desc=self.cmd_TC_RAISE_help)
        self.gcode.register_command(
            'TC_DETECT', self.cmd_TC_DETECT, desc=self.cmd_TC_DETECT_help)
        self.gcode.register_command(
            'TC_MEASURE_Z', self.cmd_TC_MEASURE_Z,
            desc=self.cmd_TC_MEASURE_Z_help)
        self.gcode.register_command(
            'TC_SET_Z_OFFSET', self.cmd_TC_SET_Z_OFFSET,
            desc=self.cmd_TC_SET_Z_OFFSET_help)
        self.z_measure = None
        # Live per-tool probe pin states. tool_probe registers every probe pin
        # with the buttons module (for crash detection) and reports each
        # change to tool_probe_endstop.note_probe_triggered; record them on
        # the way through, so the UI can show them without polling. The
        # [tool_probe] sections come before this one, so the object exists.
        self.probe_states = {}
        self.auto_select = config.getboolean('auto_select', True)
        self.sensor_change_time = -99.
        self.auto_select_timer = self.reactor.register_timer(
            self._auto_select_timer)
        tpe = self.printer.lookup_object('tool_probe_endstop', None)
        if tpe is None and config.has_section('tool_probe_endstop'):
            tpe = self.printer.load_object(config, 'tool_probe_endstop')
        self.tool_probe_endstop = tpe
        if tpe is not None:
            orig = tpe.note_probe_triggered
            def note_probe_triggered(probe, eventtime, is_triggered):
                n = _probe_tool_number(probe)
                if n is not None:
                    self.probe_states[str(n)] = bool(is_triggered)
                    self._sensor_changed()
                return orig(probe, eventtime, is_triggered)
            tpe.note_probe_triggered = note_probe_triggered
            # A dropped tool pauses the print and turns the hotends off, but
            # keeps homing (the stock crash_gcode ran M84).
            gcode_macro = self.printer.load_object(config, 'gcode_macro')
            tpe.crash_gcode = gcode_macro.load_template(
                config, 'crash_gcode', '_TC_ON_CRASH')

    def _handle_connect(self):
        self.toolchanger = self.printer.lookup_object('toolchanger')

    def _wrap_command(self, name, wrapper):
        """Replace command `name` with wrapper(orig, gcmd), if it exists."""
        orig = self.gcode.register_command(name, None)
        if orig is None:
            return
        desc = getattr(self.gcode, 'gcode_help', {}).get(name)
        self.gcode.register_command(
            name, lambda gcmd: wrapper(orig, gcmd), desc=desc)

    def _handle_ready(self):
        # Wrap whatever _TAP_PROBE_ACTIVATE the printer has. Upstream's
        # version never heats, so then nothing is ever recorded.
        if self.probe_heat_off_delay:
            self._wrap_command('_TAP_PROBE_ACTIVATE', self._probe_activate)
        for name in ('SELECT_TOOL', 'UNSELECT_TOOL'):
            self._wrap_command(name, self._guard_stray_tool)
        if self.tool_probe_endstop is not None:
            self._wrap_command('DETECT_ACTIVE_TOOL_PROBE', self._detect_probes)
        # A tool already on the gantry at startup counts as just placed
        self._sensor_changed()

    def _detect_probes(self, orig, gcmd):
        # Macros run DETECT_ACTIVE_TOOL_PROBE too; keep the live map in step
        # with each fresh read of all sensors.
        orig(gcmd)
        for n, triggered in self._last_query().items():
            self.probe_states[str(n)] = bool(triggered)

    def _guard_stray_tool(self, orig, gcmd):
        # A tool put on the gantry by hand isn't known to the toolchanger:
        # a pickup or dropoff would then carry it into a dock. Outside
        # prints, refuse to move until it is selected (TC_DETECT /
        # INITIALIZE_TOOLCHANGER, no motion) or taken off.
        now = self.reactor.monotonic()
        tc = self.toolchanger
        if (tc is not None and tc.status == 'ready'
                and not self._is_printing(now) and not self._probing(now)):
            active = tc.active_tool.tool_number if tc.active_tool else -1
            strays = sorted(int(n) for n, docked in self._probe_status().items()
                            if not docked and int(n) != active)
            if strays:
                raise gcmd.error(
                    "T%d is on the gantry (its sensor says so) but the "
                    "toolchanger has %s selected, so moving could carry it "
                    "into a dock. Run TC_DETECT (no motion) to select it, or "
                    "take it off by hand." % (
                        strays[0], 'T%d' % active if active >= 0 else 'no tool'))
        orig(gcmd)

    def _is_printing(self, eventtime):
        ps = self.printer.lookup_object('print_stats', None)
        return ps is not None and ps.get_status(eventtime)['state'] in (
            'printing', 'paused')

    def _heater_target(self, name, eventtime):
        try:
            heater = self.printer.lookup_object('heaters').lookup_heater(name)
        except Exception:
            return None
        return heater.get_status(eventtime)['target']

    def _probe_activate(self, orig, gcmd):
        heater = gcmd.get('HEATER', None)
        before = self._heater_target(heater, self.reactor.monotonic())
        orig(gcmd)
        now = self.reactor.monotonic()
        if self._is_printing(now):
            return
        after = self._heater_target(heater, now)
        if before == 0. and after:
            self.probe_heated[heater] = after
        if self.probe_heated:
            # Count down only once probing (and anything else) has finished
            self.probe_heat_wait = True
            self.reactor.update_timer(self.probe_heat_timer, now + 5.)

    def _probe_heat_timer(self, eventtime):
        if self._is_printing(eventtime):
            # A print owns the temperatures now
            self.probe_heated.clear()
            return self.reactor.NEVER
        idle = self.printer.lookup_object('idle_timeout', None)
        busy = (idle is not None
                and idle.get_status(eventtime)['state'] == 'Printing')
        if busy or self.gcode.get_mutex().test():
            self.probe_heat_wait = True
            return eventtime + 5.
        if self.probe_heat_wait:
            self.probe_heat_wait = False
            return eventtime + self.probe_heat_off_delay
        self._probe_heat_off(eventtime, self._run_from_timer)
        return self.reactor.NEVER

    def _probe_heat_off(self, eventtime, run=None):
        heated, self.probe_heated = self.probe_heated, {}
        for heater, temp in heated.items():
            # Leave a temperature someone set since then alone
            if self._heater_target(heater, eventtime) == temp:
                (run or self.gcode.run_script_from_command)(
                    "SET_HEATER_TEMPERATURE HEATER=%s TARGET=0\n"
                    "RESPOND MSG=\"%s turned off (only heated for probing)\""
                    % (heater, heater))

    def _homing_move_begin(self, *args):
        self.homing_move_active = True

    def _homing_move_end(self, *args):
        self.homing_move_active = False
        self.homing_move_end_time = self.reactor.monotonic()

    def _probing(self, eventtime):
        # The sensor releases once the nozzle lifts after a probe; allow a
        # moment for that.
        return (self.homing_move_active
                or eventtime - self.homing_move_end_time < 2.)

    def _sensor_changed(self):
        if not self.auto_select:
            return
        now = self.reactor.monotonic()
        self.sensor_change_time = now
        self.reactor.update_timer(self.auto_select_timer,
                                  now + AUTO_SELECT_SETTLE)

    def _auto_select_timer(self, eventtime):
        # A tool put on the empty gantry by hand: select it (TC_DETECT runs
        # INITIALIZE_TOOLCHANGER, which doesn't move), so docking and
        # pickups know it is there. Only when nothing is selected and
        # nothing is going on; a tool change, alignment (docking mode) or
        # failed pickup leaves the toolchanger in another state.
        if eventtime - self.sensor_change_time < AUTO_SELECT_SETTLE - .01:
            return self.sensor_change_time + AUTO_SELECT_SETTLE
        tc = self.toolchanger
        if (tc is None or tc.active_tool is not None
                or tc.status not in ('ready', 'uninitialized')
                or self._is_printing(eventtime) or self._probing(eventtime)
                or self._detected_tool(self._probe_status()) < 0):
            return self.reactor.NEVER
        idle = self.printer.lookup_object('idle_timeout', None)
        if ((idle is not None
             and idle.get_status(eventtime)['state'] == 'Printing')
                or self.gcode.get_mutex().test()):
            return eventtime + 1.  # check again once the printer is idle
        self._run_from_timer("TC_DETECT")
        return self.reactor.NEVER

    def _run_from_timer(self, script):
        # An error escaping a reactor timer would shut Klipper down
        try:
            self.gcode.run_script(script)
        except Exception as e:
            self.gcode.respond_info("ToolConfig: %s failed: %s"
                                    % (script.split()[0], e))

    def _tools(self):
        tc = self.toolchanger
        return list(tc.tools.values()) if tc else []

    def _sensor_kind(self):
        if self.tool_probe_endstop is not None:
            return 'tool_probe'
        tools = self._tools()
        if self._detection_states():
            return 'detection_pin'
        if any(getattr(t, 'probe', None) is not None for t in tools):
            return 'tool_probe'
        return 'none'

    def _detection_states(self):
        """tool number -> True if its detection_pin says it is mounted.

        Empty unless the toolchanger uses detection pins. easy and upstream
        use different values for detect_state (-1/0/1 vs strings), so take
        them from whichever toolchanger module is loaded."""
        tc = self.toolchanger
        if tc is None or not getattr(tc, 'has_detection', False):
            return {}
        mod = sys.modules.get(type(tc).__module__)
        present = getattr(mod, 'DETECT_PRESENT', None)
        unavailable = getattr(mod, 'DETECT_UNAVAILABLE', None)
        out = {}
        for t in self._tools():
            state = getattr(t, 'detect_state', unavailable)
            if state != unavailable and t.tool_number >= 0:
                out[t.tool_number] = state == present
        return out

    def _registered_probes(self):
        """tool number -> tool_probe object, from whichever setup is used."""
        tpe = self.tool_probe_endstop
        if tpe is not None:
            reg = getattr(tpe, 'tool_probes', None)
            if reg is None:
                reg = getattr(tpe, 'tool_number_to_probe', {})
            return dict(reg)
        return {t.tool_number: t.probe for t in self._tools()
                if getattr(t, 'probe', None) is not None}

    cmd_TC_CLEAR_ACTIVE_TOOL_help = (
        "Forget the active tool without moving (carriage must be empty)")
    def cmd_TC_CLEAR_ACTIVE_TOOL(self, gcmd):
        tc = self.toolchanger
        if tc.status == 'changing':
            raise gcmd.error(
                "Cannot clear the active tool during a tool change")
        if tc.active_tool is None:
            return
        name = tc.active_tool.name
        tc._configure_toolhead_for_tool(None)
        tc.gcode_transform.tool = None
        self.printer.lookup_object('gcode_move').reset_last_position()
        gcmd.respond_info("Cleared active tool (%s)" % (name,))

    # action_raise_error() aborts a macro while it is still being rendered,
    # so none of its earlier commands run; this raises once they have.
    cmd_TC_RAISE_help = "Abort the running macro with an error message"
    def cmd_TC_RAISE(self, gcmd):
        raise gcmd.error(gcmd.get('MSG', 'Toolchanger error'))

    cmd_TC_DETECT_help = ("Read every tool sensor and select the tool that is"
                          " on the gantry (no motion; SELECT=0 to only read)")
    def cmd_TC_DETECT(self, gcmd):
        if self.tool_probe_endstop is not None:
            # Also selects the active Z probe, as the toolchanger expects
            self.gcode.run_script_from_command('DETECT_ACTIVE_TOOL_PROBE')
        else:
            # Probes owned by the toolchanger: read them, but leave the
            # active probe to the toolchanger. detection_pin is live anyway.
            toolhead = self.printer.lookup_object('toolhead')
            print_time = toolhead.get_last_move_time()
            for n, probe in self._registered_probes().items():
                self.probe_states[str(n)] = bool(
                    probe.mcu_probe.query_endstop(print_time))
        probes = self._probe_status()
        if not probes:
            gcmd.respond_info("No tool sensors configured")
            return
        gcmd.respond_info("Tool sensors: %s" % (', '.join(
            'T%s %s' % (n, 'in dock' if docked else 'ON GANTRY')
            for n, docked in sorted(probes.items(), key=lambda i: int(i[0]))),))
        # A tool put on by hand: make the toolchanger select it, so the next
        # dropoff or pickup knows it is there (INITIALIZE_TOOLCHANGER only
        # applies the tool's settings, it doesn't move).
        tc = self.toolchanger
        detected = self._detected_tool(probes)
        if (gcmd.get_int('SELECT', 1) and tc is not None and detected >= 0
                and tc.status in ('ready', 'uninitialized')
                and not self._is_printing(self.reactor.monotonic())):
            active = tc.active_tool.tool_number if tc.active_tool else -1
            if detected != active:
                gcmd.respond_info("Selecting T%d (it is on the gantry)"
                                  % (detected,))
                self.gcode.run_script_from_command('INITIALIZE_TOOLCHANGER')

    # ---- Z offsets ----------------------------------------------------------
    def _tool(self, n):
        for t in self._tools():
            if t.tool_number == n:
                return t
        return None

    def _probe_z_offset(self, probe):
        po = getattr(probe, 'probe_offsets', None)
        if po is not None and hasattr(po, 'z_offset'):
            return po.z_offset
        return probe.get_offsets()[2]

    def _select(self, n):
        # The T<n> macro, if there is one, is what everything else uses
        cmd = 'T%d' % n
        if cmd not in getattr(self.gcode, 'ready_gcode_handlers', {}):
            cmd = 'SELECT_TOOL T=%d' % n
        self.gcode.run_script_from_command(cmd)

    def _active_number(self):
        tc = self.toolchanger
        return tc.active_tool.tool_number if tc and tc.active_tool else -1

    cmd_TC_MEASURE_Z_help = (
        "Probe one bed spot with each tool and propose Z offsets"
        " [TOOLS=0,1,..] [REF=0] [X=] [Y=] [CLEARANCE=10]")
    def cmd_TC_MEASURE_Z(self, gcmd):
        tc = self.toolchanger
        probes = self._registered_probes()
        probe_obj = self.printer.lookup_object('probe', None)
        if not probes or probe_obj is None or tc is None:
            raise gcmd.error("TC_MEASURE_Z needs a probe on every tool")
        now = self.reactor.monotonic()
        toolhead = self.printer.lookup_object('toolhead')
        th = toolhead.get_status(now)
        if th['homed_axes'] != 'xyz':
            raise gcmd.error("Home the printer first")
        if self._is_printing(now):
            raise gcmd.error("Not during a print")
        if tc.status != 'ready':
            raise gcmd.error("The toolchanger is %s, not ready" % (tc.status,))
        tools = sorted(probes)
        if gcmd.get('TOOLS', None):
            try:
                tools = sorted(set(int(t) for t in
                                   gcmd.get('TOOLS').replace('T', '').split(',')))
            except ValueError:
                raise gcmd.error("TOOLS must look like 0,1,3")
        ref = gcmd.get_int('REF', 0 if 0 in probes else tools[0])
        tools = [ref] + [n for n in tools if n != ref]
        for n in tools:
            if n not in probes or self._tool(n) is None:
                raise gcmd.error("T%d has no tool probe" % (n,))
        x = gcmd.get_float('X', (th['axis_minimum'][0] + th['axis_maximum'][0]) / 2.)
        y = gcmd.get_float('Y', (th['axis_minimum'][1] + th['axis_maximum'][1]) / 2.)
        clearance = gcmd.get_float('CLEARANCE', 10., minval=3.)
        start = self._active_number()
        triggers, spreads = {}, {}
        before = {n: (self._probe_z_offset(probes[n]),
                      self._tool(n).gcode_z_offset or 0.) for n in tools}

        def publish(complete):
            props = z_proposals(triggers, ref, before[ref][1]) \
                if ref in triggers else {}
            self.z_measure = {
                'time': time.time(), 'x': x, 'y': y, 'reference': ref,
                'complete': complete,
                'tools': {str(n): {
                    'trigger': round(triggers[n], 4),
                    'spread': round(spreads[n], 4),
                    'probe_z_offset': before[n][0],
                    'gcode_z_offset': before[n][1],
                    'new_probe_z_offset': props.get(n, (None, None))[0],
                    'new_gcode_z_offset': props.get(n, (None, None))[1],
                } for n in triggers}}

        run = self.gcode.run_script_from_command
        for n in tools:
            if self._active_number() != n:
                self._select(n)
            if n == ref:
                # Z zero comes from the reference tool's probe
                run("G28 Z")
            run("G90\nG0 X%.3f Y%.3f F12000\nG0 Z%.3f F3000"
                % (x, y, clearance))
            zs = []
            for _ in range(2):
                run("PROBE")
                # Where the probe triggered (toolhead Z), before its z_offset
                # is taken off
                zs.append(probe_obj.get_status(
                    self.reactor.monotonic())['last_z_result'])
                run("G0 Z%.3f F1200" % (clearance,))
            triggers[n] = sum(zs) / len(zs)
            spreads[n] = max(zs) - min(zs)
            publish(n == tools[-1])
            # Don't leave it at probe temperature in its dock
            self._probe_heat_off(self.reactor.monotonic())
        if start >= 0 and self._active_number() != start:
            self._select(start)
        self._report_z(gcmd)

    def _report_z(self, gcmd):
        m = self.z_measure
        lines = ["Z measured at X%.1f Y%.1f (trigger height = toolhead Z where"
                 " the probe triggered):" % (m['x'], m['y'])]
        ref = m['reference']
        for n, r in sorted(m['tools'].items(), key=lambda i: int(i[0])):
            line = "T%s: trigger %.3f" % (n, r['trigger'])
            if r['spread'] > Z_MEASURE_SPREAD:
                line += " (UNSTEADY: %.3f between probes)" % (r['spread'],)
            if int(n) == ref:
                line += ", reference (its z_offset is %.3f)" % (
                    r['probe_z_offset'],)
            else:
                line += (", probe z_offset %.3f -> %.3f, gcode_z_offset"
                         " %.3f -> %.3f" % (
                             r['probe_z_offset'], r['new_probe_z_offset'],
                             r['gcode_z_offset'], r['new_gcode_z_offset']))
            lines.append(line)
        lines.append("Apply and save them on the ToolConfig Z offsets tab"
                     " (TC_SET_Z_OFFSET only applies until a restart).")
        gcmd.respond_info("\n".join(lines))

    cmd_TC_SET_Z_OFFSET_help = (
        "Apply a tool's Z offsets now, until restart:"
        " T=<n> [PROBE_Z=] [GCODE_Z=]")
    def cmd_TC_SET_Z_OFFSET(self, gcmd):
        n = gcmd.get_int('T')
        tool = self._tool(n)
        if tool is None:
            raise gcmd.error("No tool T%d" % (n,))
        tc = self.toolchanger
        if tc.status == 'changing' and tc.active_tool is tool:
            raise gcmd.error("Not while T%d is being changed" % (n,))
        probe_z = gcmd.get_float('PROBE_Z', None)
        gcode_z = gcmd.get_float('GCODE_Z', None)
        if probe_z is not None:
            probe = self._registered_probes().get(n)
            po = getattr(probe, 'probe_offsets', None)
            if po is None or not hasattr(po, 'z_offset'):
                raise gcmd.error("Can't change T%d's probe z_offset live" % (n,))
            po.z_offset = probe_z
        if gcode_z is not None:
            tool.set_parameter('gcode_z_offset', gcode_z)
            if tc.active_tool is tool:
                # Z in G-code coordinates now means something else; no motion
                self.printer.lookup_object('gcode_move').reset_last_position()
        gcmd.respond_info("T%d: %s" % (n, ', '.join(
            s for s in ("probe z_offset %.3f" % probe_z if probe_z is not None
                        else '', "gcode_z_offset %.3f" % gcode_z
                        if gcode_z is not None else '') if s) or 'nothing set'))

    def _last_query(self):
        tpe = self.tool_probe_endstop
        return dict(getattr(tpe, 'last_query', None) or {}) if tpe else {}

    def _probe_status(self):
        out = {}
        if self.tool_probe_endstop is not None:
            for n in self._registered_probes():
                out[str(n)] = False
            # The buttons module doesn't report a sensor that is already
            # pressed when Klipper starts; the probe endstop's own query (at
            # connect and on every DETECT) covers those until they change.
            for n, triggered in self._last_query().items():
                out[str(n)] = bool(triggered)
        out.update(self.probe_states)
        for n, present in self._detection_states().items():
            out[str(n)] = not present
        return out

    def _detected_tool(self, probes):
        # Not tool_probe_endstop.active_tool_number: that is the Z probe in
        # use and stays on a tool after it is docked, until the next DETECT.
        tc = self.toolchanger
        if tc is not None and getattr(tc, 'has_detection', False):
            return tc.detected_tool.tool_number if tc.detected_tool else -1
        on_gantry = [int(n) for n, docked in probes.items() if not docked]
        return on_gantry[0] if len(on_gantry) == 1 else -1

    def get_status(self, eventtime):
        tc = self.toolchanger
        probes = self._probe_status()
        return {
            # klipper-toolchanger keeps the last message after recovery
            'error_message': tc.error_message if tc and tc.status == 'error'
                             else '',
            'active_tool': tc.active_tool.name if tc and tc.active_tool
                           else None,
            # tool number -> True when the sensor says the tool is docked
            'probes': probes,
            # tool number the sensors put on the gantry, -1 for none/unclear
            'detected_tool': self._detected_tool(probes),
            # 'tool_probe', 'detection_pin' or 'none'
            'sensors': self._sensor_kind(),
            # a probing/homing move is running (or just ended): the active
            # tool's Tap sensor reading "docked" is the nozzle on the bed
            'probing': self._probing(eventtime),
            # live probe z_offset per tool (TC_SET_Z_OFFSET changes it)
            'probe_z_offsets': {
                str(n): self._probe_z_offset(p)
                for n, p in self._registered_probes().items()},
            # last TC_MEASURE_Z, or None
            'z_measure': self.z_measure,
        }

def load_config(config):
    return ToolchangerUI(config)
