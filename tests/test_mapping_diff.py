import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from lib.mapping_diff import MappingDiff
from lib.webpack import Webpack

ROOT = Path(__file__).resolve().parents[1]
TEMP = Path(os.environ.get('TMPDIR') or '/var/tmp/omp-1000')
TEMP.mkdir(mode=0o700, parents=True, exist_ok=True)


def compare(old, new):
    base = SimpleNamespace(timestamp='100', load=lambda: Webpack(old))
    current = SimpleNamespace(timestamp='200', load=lambda: Webpack(new))
    with contextlib.redirect_stdout(io.StringIO()):
        mapped, added = MappingDiff(base, current).process()
    return {source: entry.search.id for source, entry in mapped.items()}, {entry.search.id for entry in added}


class MappingDiffTest(unittest.TestCase):
    def test_continuing_module_cannot_steal_a_new_modules_predecessor(self):
        old = {'1': {'Panel': 'original'}, '7': {'Panel': 'removed'}}
        new = {'1': {'Panel': 'original'}, '2': {'Panel': 'replacement'}}
        mapped, added = compare(old, new)
        self.assertEqual(mapped, {'7': '2'})
        self.assertEqual(added, set())

    def test_a_new_clone_does_not_take_the_surviving_modules_history(self):
        mapped, added = compare({'1': {'Panel': 'original'}},
                                {'1': {'Panel': 'original'}, '2': {'Panel': 'clone'}})
        self.assertEqual(mapped, {})
        self.assertEqual(added, {'2'})

    def test_reused_id_gets_a_new_history_while_its_old_object_moves(self):
        mapped, added = compare({'1': {'OldPanel': 'old'}},
                                {'1': {'UnrelatedPanel': 'new'}, '2': {'OldPanel': 'moved'}})
        self.assertEqual(mapped, {'1': '2'})
        self.assertEqual(added, {'1'})

    def test_split_keeps_the_main_move_and_records_the_remaining_module(self):
        old = {'1': {f'Field{i}': f'class{i}' for i in range(10)}}
        new = {'1': {'Field0': 'class0'}, '2': {f'Field{i}': f'class{i}' for i in range(1, 10)}}
        mapped, added = compare(old, new)
        self.assertEqual(mapped, {'1': '2'})
        self.assertEqual(added, {'1'})


class ChainTest(unittest.TestCase):
    def test_stable_uses_its_base_identity_after_beta_reuses_the_same_id(self):
        with tempfile.TemporaryDirectory(dir=TEMP) as directory:
            root = Path(directory)
            (root / 'webpack').mkdir()
            (root / 'webpack-mappings').mkdir()
            old = {'1': {'OldPanel': 'old'}}
            updated = {'1': {'UnrelatedPanel': 'new'}, '2': {'OldPanel': 'moved'}}
            for version, payload in [('100.stable', old), ('110.beta', old),
                                     ('200.beta', updated), ('210.stable', updated)]:
                (root / 'webpack' / f'{version}.json').write_text(json.dumps(payload))
            subprocess.run([sys.executable, str(ROOT / 'webpack_id_mappings.py')], cwd=root,
                           check=True, capture_output=True, text=True)
            chains = json.loads((root / 'webpack_id_mappings.json').read_text())
            self.assertCountEqual(list(chains.values()), [
                {'100': '1', '110': '1', '200': '2', '210': '2'},
                {'200': '1', '210': '1'},
            ])
            for filename in ['100to210.json', '110to200.json']:
                transition = json.loads((root / 'webpack-mappings' / filename).read_text())
                self.assertEqual(set(transition['mapped']), {'1'})
                self.assertEqual([entry['new'] for entry in transition['new']], ['1'])

    def test_new_stable_module_cannot_take_a_partner_chain_still_used_by_its_base(self):
        with tempfile.TemporaryDirectory(dir=TEMP) as directory:
            root = Path(directory)
            (root / 'webpack').mkdir()
            (root / 'webpack-mappings').mkdir()
            old = {'1': {'OldPanel': 'old'}}
            beta = {'2': {'OldPanel': 'moved'}}
            stable = {'1': {'OldPanel': 'old'}, '2': {'NewPanel': 'new'}}
            for version, payload in [('100.stable', old), ('110.beta', old),
                                     ('200.beta', beta), ('210.stable', stable)]:
                (root / 'webpack' / f'{version}.json').write_text(json.dumps(payload))
            subprocess.run([sys.executable, str(ROOT / 'webpack_id_mappings.py')], cwd=root,
                           check=True, capture_output=True, text=True)
            chains = json.loads((root / 'webpack_id_mappings.json').read_text())
            self.assertCountEqual(list(chains.values()), [
                {'100': '1', '110': '1', '200': '2', '210': '1'},
                {'210': '2'},
            ])


if __name__ == '__main__':
    unittest.main()
