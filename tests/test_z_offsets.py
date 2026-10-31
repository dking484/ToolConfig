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
rehome_points = toolchanger_ui.rehome_points
rehome_shift = toolchanger_ui.rehome_shift

QGL = [(50, 25), (50, 275), (300, 275), (300, 25)]


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

    def test_furthest_pair_without_a_print(self):
        self.assertEqual(rehome_points(QGL, [], 15.),
                         [(50., 25.), (300., 275.)])

    def test_skips_spots_near_the_print(self):
        part = [(30, 10), (200, 10), (200, 150), (30, 150)]
        self.assertEqual(rehome_points(QGL, [part], 15.),
                         [(50., 275.), (300., 25.)])

    def test_prefers_spots_inside_the_mesh(self):
        in_mesh = lambda x, y: 40 <= x <= 310 and 40 <= y <= 310
        # (50, 25) and (300, 25) lie outside the mesh
        pts = rehome_points(QGL + [(40, 40), (310, 310)], [], 15., in_mesh)
        self.assertEqual(pts, [(40., 40.), (310., 310.)])

    def test_too_few_clear_spots(self):
        bed = [(0, 0), (350, 0), (350, 350), (0, 350)]
        self.assertEqual(rehome_points(QGL, [bed], 15.), [])


if __name__ == '__main__':
    unittest.main()
