# python -m unittest discover tests
import importlib.util
import os
import shutil
import tempfile
import unittest

_path = os.path.join(os.path.dirname(__file__), '..', 'klipper', 'extras',
                     'toolchanger_ui.py')
_spec = importlib.util.spec_from_file_location('toolchanger_ui', _path)
tu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tu)

TOOL = """[tool T1]
tool_number: 1
gcode_x_offset: 0
gcode_z_offset: -0.79

[tool_probe T1]
pin: ^EBBT1:PB6
z_offset: 0 # Z axis-sensor relative nozzle offset
activate_gcode:
    _TAP_PROBE_ACTIVATE HEATER=extruder1
"""


class SetOption(unittest.TestCase):
    def test_keeps_inline_comment(self):
        out = tu.cfg_set_option(TOOL, 'tool_probe T1', 'z_offset', '-1.814')
        self.assertIn('z_offset: -1.814 # Z axis-sensor relative nozzle offset\n', out)
        self.assertEqual(out.count('\n'), TOOL.count('\n'))

    def test_replaces_value(self):
        out = tu.cfg_set_option(TOOL, 'tool T1', 'gcode_z_offset', '-0.819')
        self.assertIn('gcode_z_offset: -0.819\n', out)
        self.assertNotIn('-0.79\n', out)

    def test_adds_missing_key_after_multiline_value(self):
        out = tu.cfg_set_option(TOOL, 'tool_probe T1', 'speed', '5')
        self.assertTrue(out.endswith('    _TAP_PROBE_ACTIVATE HEATER=extruder1\nspeed: 5\n'))

    def test_section_name_spacing_and_case(self):
        out = tu.cfg_set_option(TOOL, 'TOOL  T1', 'gcode_z_offset', '0.1')
        self.assertIn('gcode_z_offset: 0.1\n', out)

    def test_keeps_crlf(self):
        out = tu.cfg_set_option(TOOL.replace('\n', '\r\n'), 'tool T1', 'gcode_z_offset', '1')
        self.assertNotIn('\n', out.replace('\r\n', ''))

    def test_missing_section(self):
        with self.assertRaises(ValueError):
            tu.cfg_set_option(TOOL, 'tool T9', 'gcode_z_offset', '1')

    def test_ignores_save_config_block(self):
        text = TOOL + '#*# <---------------------- SAVE_CONFIG ---------------------->\n#*# [tool T1]\n#*# gcode_z_offset = 5\n'
        out = tu.cfg_set_option(text, 'tool T1', 'gcode_z_offset', '1')
        self.assertIn('gcode_z_offset: 1\n', out)
        self.assertIn('#*# gcode_z_offset = 5', out)


class Files(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, 'tools'))
        self.write('printer.cfg', '[include tools/*.cfg]\n[printer]\nkinematics: corexy\n'
                   '#*# <---------------------- SAVE_CONFIG ---------------------->\n'
                   '#*# [tool_probe_endstop]\n#*# z_offset = -1.230\n')
        self.write('tools/T1.cfg', TOOL)
        self.write('tools/T0.cfg', '[tool_probe T0]\nz_offset: -1.0 #05\n')

    def tearDown(self):
        shutil.rmtree(self.dir)

    def write(self, rel, text):
        with open(os.path.join(self.dir, rel), 'w', newline='') as f:
            f.write(text)

    def test_locate_follows_includes(self):
        main = os.path.join(self.dir, 'printer.cfg')
        self.assertEqual(tu.cfg_locate(main, 'tool_probe T1', 'z_offset'),
                         os.path.join(self.dir, 'tools', 'T1.cfg'))
        self.assertIsNone(tu.cfg_locate(main, 'tool T7', 'gcode_z_offset'))

    def test_later_definition_wins(self):
        self.write('printer.cfg', '[include tools/*.cfg]\n[tool T1]\ngcode_z_offset: 3\n')
        main = os.path.join(self.dir, 'printer.cfg')
        self.assertEqual(tu.cfg_locate(main, 'tool T1', 'gcode_z_offset'), main)

    def test_autosave(self):
        a = tu.cfg_autosave(tu._read(os.path.join(self.dir, 'printer.cfg')))
        self.assertEqual(a, {'tool_probe_endstop': {'z_offset': '-1.230'}})

    def test_save_options_writes_and_backs_up(self):
        class Printer:
            def get_start_args(s):
                return {'config_file': os.path.join(self.dir, 'printer.cfg')}
        ui = tu.ToolchangerUI.__new__(tu.ToolchangerUI)
        ui.printer = Printer()
        files = ui._save_options([('tool_probe T0', 'z_offset', '-1.050'),
                                  ('tool_probe T1', 'z_offset', '-1.864')])
        self.assertEqual(sorted(files), [os.path.join('tools', 'T0.cfg'), os.path.join('tools', 'T1.cfg')])
        self.assertEqual(tu._read(os.path.join(self.dir, 'tools', 'T0.cfg')),
                         '[tool_probe T0]\nz_offset: -1.050 #05\n')
        backups = os.listdir(os.path.join(self.dir, 'toolconfig-backups'))
        self.assertEqual(len(backups), 2)
        self.assertTrue(any(b.startswith('tools__T0.cfg.') for b in backups))

    def test_save_options_refuses_save_config_override(self):
        class Printer:
            def get_start_args(s):
                return {'config_file': os.path.join(self.dir, 'printer.cfg')}
        ui = tu.ToolchangerUI.__new__(tu.ToolchangerUI)
        ui.printer = Printer()
        with self.assertRaises(Exception):
            ui._save_options([('tool_probe_endstop', 'z_offset', '0')])
        self.assertFalse(os.path.exists(os.path.join(self.dir, 'toolconfig-backups')))


if __name__ == '__main__':
    unittest.main()
