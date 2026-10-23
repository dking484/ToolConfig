# Helpers for klipper-toolchanger-ui
#
# Adds what the macros in toolchanger-safety.cfg cannot do on their own:
#  - TC_CLEAR_ACTIVE_TOOL: forget the "active" tool without any motion, used
#    after a failed pickup left the toolchanger pointing at a tool that is
#    not actually on the carriage.
#  - printer.toolchanger_ui status: the toolchanger's error message, which
#    klipper-toolchanger does not publish itself.
#
# This file may be distributed under the terms of the GNU GPLv3 license.

class ToolchangerUI:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.gcode = self.printer.lookup_object('gcode')
        self.toolchanger = None
        self.printer.register_event_handler('klippy:connect',
                                            self._handle_connect)
        self.gcode.register_command(
            'TC_CLEAR_ACTIVE_TOOL', self.cmd_TC_CLEAR_ACTIVE_TOOL,
            desc=self.cmd_TC_CLEAR_ACTIVE_TOOL_help)
        self.gcode.register_command(
            'TC_RAISE', self.cmd_TC_RAISE, desc=self.cmd_TC_RAISE_help)

    def _handle_connect(self):
        self.toolchanger = self.printer.lookup_object('toolchanger')

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

    def get_status(self, eventtime):
        tc = self.toolchanger
        return {
            # klipper-toolchanger keeps the last message after recovery
            'error_message': tc.error_message if tc and tc.status == 'error'
                             else '',
            'active_tool': tc.active_tool.name if tc and tc.active_tool
                           else None,
        }

def load_config(config):
    return ToolchangerUI(config)
