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
under_print = toolchanger_ui.under_print
rehome_shift = toolchanger_ui.rehome_shift


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


class Rehome(unittest.TestCase):
    def test_shift_when_z_lost_steps(self):
        # 2026-10-30: after a failed T4 pickup T0 triggered at +0.31 where
        # homing makes it trigger at its z_offset -1.0: the nozzle was 1.31
        # closer to the bed than Z said
        self.assertEqual(rehome_shift(-1.0, 0., 0.31), -1.31)

    def test_shift_uses_bed_height(self):
        self.assertEqual(rehome_shift(-0.969, -0.08, -1.049), 0.)

    def test_centre_under_a_print_in_the_middle(self):
        part = [(120, 120), (230, 120), (230, 230), (120, 230)]
        self.assertTrue(under_print(175, 175, [part], 15.))

    def test_centre_clear_of_a_print_in_a_corner(self):
        part = [(30, 200), (120, 200), (120, 300), (30, 300)]
        self.assertFalse(under_print(175, 175, [part], 15.))

    def test_margin_counts(self):
        part = [(30, 30), (165, 30), (165, 165), (30, 165)]
        self.assertTrue(under_print(175, 175, [part], 15.))
        self.assertFalse(under_print(175, 175, [part], 5.))

    def test_no_outlines(self):
        self.assertFalse(under_print(175, 175, [[]], 15.))


if __name__ == '__main__':
    unittest.main()
