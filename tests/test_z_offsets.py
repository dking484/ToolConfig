# python -m unittest discover tests
import importlib.util
import os
import unittest

_path = os.path.join(os.path.dirname(__file__), '..', 'klipper', 'extras',
                     'toolchanger_ui.py')
_spec = importlib.util.spec_from_file_location('toolchanger_ui', _path)
toolchanger_ui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(toolchanger_ui)
z_proposals = toolchanger_ui.z_proposals
babystep_changes = toolchanger_ui.babystep_changes


class ZProposals(unittest.TestCase):
    def test_reference_is_left_out(self):
        self.assertEqual(z_proposals({0: -0.5}, 0, 0.), {})

    def test_longer_nozzle(self):
        # T1 triggers 0.3 higher than T0: its nozzle reaches the bed 0.3
        # sooner, so G-code Z must lift it 0.3, and homing with it must call
        # that trigger point -0.2.
        self.assertEqual(z_proposals({0: -0.5, 1: -0.2}, 0, 0.), {1: (-0.2, 0.3)})

    def test_shorter_nozzle(self):
        self.assertEqual(z_proposals({0: -0.5, 2: -0.75}, 0, 0.),
                         {2: (-0.75, -0.25)})

    def test_reference_gcode_offset_carries_over(self):
        self.assertEqual(z_proposals({0: -0.5, 1: -0.4}, 0, 0.05),
                         {1: (-0.4, 0.15)})

    def test_other_reference(self):
        self.assertEqual(z_proposals({1: -0.4, 3: -0.4}, 1, 0.), {3: (-0.4, 0.)})

    def test_rounded(self):
        self.assertEqual(z_proposals({0: -0.50004, 1: -0.12346}, 0, 0.),
                         {1: (-0.123, 0.377)})


class Babysteps(unittest.TestCase):
    def test_reference_moves_every_probe(self):
        # +0.05 with T0 on: the nozzle was too low, so the true zero is
        # higher and every trigger height is 0.05 lower
        self.assertEqual(
            babystep_changes(0.05, 0, 0, {0: -1.0, 1: -1.814}, 0.),
            {0: {'probe_z': -1.05}, 1: {'probe_z': -1.864}})

    def test_other_tool_keeps_it_in_its_gcode_offset(self):
        self.assertEqual(
            babystep_changes(-0.02, 1, 0, {0: -1.0, 1: -1.814}, -0.819),
            {1: {'gcode_z': -0.839}})


if __name__ == '__main__':
    unittest.main()
