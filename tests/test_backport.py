import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMP = Path(os.environ.get('TMPDIR') or '/var/tmp/omp-1000')
TEMP.mkdir(mode=0o700, parents=True, exist_ok=True)


def backport(dumps, literals=None, classname_mappings=None):
    """Run the real backport on a mapping doc for the supplied dumps."""
    if classname_mappings is None:
        classname_mappings = {
            'versions': {'100': 'stable', '150': 'beta', '200': 'stable'},
            'module_mappings': {'m': {
                'name': 'menu',
                'ids': {'100': '1', '150': '1', '200': '1'},
                'classname_mappings': {
                    'Button': {'0': 'Button', '100': 'stable_hash', '150': 'beta_hash'},
                    'Launch': {'0': 'Launch', '100': 'launch_hash'},
                },
            }},
        }
    with tempfile.TemporaryDirectory(dir=TEMP) as tmp:
        repo = Path(tmp)
        (repo / 'classname_mappings.json').write_text(json.dumps(classname_mappings))
        (repo / 'webpack').mkdir()
        for name, dump in dumps.items():
            (repo / 'webpack' / name).write_text(json.dumps(dump))
        if literals is not None:
            (repo / 'webpack-literals').mkdir()
            for name, classes in literals.items():
                (repo / 'webpack-literals' / name).write_text(json.dumps(classes))
        subprocess.run([sys.executable, ROOT / 'backport_classname_mappings.py'], cwd=repo, check=True,
                       capture_output=True)
        return (json.loads((repo / 'stable.json').read_text()), json.loads((repo / 'beta.json').read_text()))


DUMPS = {'100.stable.json': {'1': {'Button': 'stable_hash', 'Launch': 'launch_hash'}},
         '150.beta.json': {'1': {'Button': 'beta_hash', 'Launch': 'launch_hash'}},
         '200.stable.json': {'1': {'Button': 'stable_hash', 'Launch': 'launch_hash'}}}


class BackportTest(unittest.TestCase):
    def test_each_branch_ends_on_the_class_in_its_own_dump(self):
        stable, beta = backport(DUMPS)
        self.assertEqual(stable['m_Button'][-1], 'stable_hash')
        self.assertIn('beta_hash', stable['m_Button'])
        self.assertEqual(beta['m_Button'][-1], 'beta_hash')
        self.assertIn('stable_hash', beta['m_Button'])

    def test_same_timestamp_uses_each_branch_dump(self):
        # The versions map keeps one branch type per timestamp, so the dumps must choose the version.
        classname_mappings = {
            'versions': {'300': 'beta'},
            'module_mappings': {'m': {
                'name': 'menu',
                'ids': {'300': '1'},
                'classname_mappings': {'Button': {'0': 'Button', '300': 'stable_hash', '301': 'beta_hash'}},
            }},
        }
        stable, beta = backport({'300.stable.json': {'1': {'Button': 'stable_hash'}},
                                 '300.beta.json': {'1': {'Button': 'beta_hash'}}},
                                classname_mappings=classname_mappings)
        self.assertEqual(stable['m_Button'][-1], 'stable_hash')
        self.assertEqual(beta['m_Button'][-1], 'beta_hash')

    def test_class_names_steam_uses_plainly_are_not_translated(self):
        stable, beta = backport(DUMPS, {'200.stable.json': ['Launch'], '150.beta.json': ['Launch']})
        self.assertEqual(stable['m_Launch'], ['_m_Launch', 'menu_Launch', 'launch_hash'])
        self.assertEqual(beta['m_Launch'], ['_m_Launch', 'menu_Launch', 'launch_hash'])
        self.assertIn('Button', stable['m_Button'], 'only listed names are removed')

    def test_versions_without_retained_literals_keep_every_alias(self):
        stable, _ = backport(DUMPS)
        self.assertEqual(stable['m_Launch'], ['_m_Launch', 'menu_Launch', 'Launch', 'launch_hash'])


if __name__ == '__main__':
    unittest.main()
