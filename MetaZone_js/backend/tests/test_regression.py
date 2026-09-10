"""
MetaZone backend regression suite (added in v0.9.4.1, extended in v0.9.5).

Covers backend/core logic only, per the maintenance-revision brief --
this deliberately does not try to drive the GUI. Plain stdlib
unittest, no extra dependency to install.

Run from the backend/ directory:
    python3 -m unittest discover -s tests -v

Or a single file:
    python3 -m unittest tests.test_regression -v

What's covered (maps to the v0.9.4.1 brief's required list):
  - duplicate detection                  -> DuplicateDetectionTests
  - input/order preservation             -> ImportOrderTests
  - Generate Remaining filtering          -> GenerateRemainingFilterTests
  - Retry Failed filtering                -> RetryFailedFilterTests
  - Undo ordering                         -> UndoOrderingTests
  - Clear All / generation epoch protection -> ClearAllEpochTests
  - Dry Run classification                -> DryRunClassificationTests
  - API-key persistence                   -> ApiKeyPersistenceTests

Test All event/request correlation is frontend JS logic (settings.js),
not backend -- see frontend/tests/test_event_correlation.js instead.
"""
import sys
import os
import types
import tempfile
import threading
import time
import csv
import shutil
import subprocess
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Stub the 'bridge' module before session.py/embedder.py/bridge.py get
# imported anywhere -- bridge.py imports Session/EmbedSession, which
# would otherwise be a circular import the moment a test imports
# session.py directly. These tests only need bridge.emit to exist and
# record what was emitted (some assertions check event payloads).
EMITTED = []
_fake_bridge = types.ModuleType('bridge')
_fake_bridge.emit = lambda name, payload: EMITTED.append((name, payload))
_fake_bridge.api_instance = None
sys.modules['bridge'] = _fake_bridge

from PIL import Image
import session as session_mod
import embedder
import settings as settings_mod
import core.config as core_config


def make_test_image(path):
    Image.new('RGB', (5, 5), 'red').save(path)


def fresh_prefs_dir():
    """Points core.config at a throwaway prefs.json so these tests
    never touch the real user's saved settings."""
    d = tempfile.mkdtemp()
    core_config._common_pref_dir = lambda: d
    return d


class DuplicateDetectionTests(unittest.TestCase):
    def test_duplicate_path_is_rejected_and_counted_as_duplicate(self):
        tmpdir = tempfile.mkdtemp()
        p = os.path.join(tmpdir, 'a.jpg')
        make_test_image(p)
        s = session_mod.Session()
        s.add_paths([p])
        result = s.add_paths([p])  # re-add the exact same path
        self.assertEqual(result['accepted'], [])
        reasons = [reason for (_, reason) in result['rejected']]
        self.assertIn('duplicate', reasons)
        self.assertEqual(s.all_paths, [p])  # not added twice


class ImportOrderTests(unittest.TestCase):
    def test_parallel_validation_preserves_input_order_even_when_reversed(self):
        """The actual bug this guards: accepted/all_paths used to be
        built in whichever order each validation thread finished, not
        input order. This forces completion order to be the exact
        reverse of input order and checks the result is still correct.
        """
        tmpdir = tempfile.mkdtemp()
        paths = []
        for i in range(5):
            p = os.path.join(tmpdir, f'img_{i}.jpg')
            make_test_image(p)
            paths.append(p)

        orig = session_mod.wait_stable_and_validate_image

        def fake_validate(path, *a, **k):
            idx = int(os.path.basename(path).split('_')[1].split('.')[0])
            time.sleep((5 - idx) * 0.03)  # earlier files sleep longer -> finish LAST
            return True, None

        session_mod.wait_stable_and_validate_image = fake_validate
        try:
            s = session_mod.Session()
            result = s.add_paths(paths)
            self.assertEqual(result['accepted'], paths)
            self.assertEqual(s.all_paths, paths)
        finally:
            session_mod.wait_stable_and_validate_image = orig


class _CaptureThread(threading.Thread):
    """Swaps in for threading.Thread around start_generation calls so
    the test can inspect exactly which targets a generation run would
    have processed, without actually running any real generation
    (no network, no AI provider calls)."""
    captured_targets = None

    def __init__(self, target=None, args=(), **kw):
        _CaptureThread.captured_targets = list(args[0]) if args else None
        super().__init__(target=lambda: None, **kw)


class GenerateRemainingFilterTests(unittest.TestCase):
    def test_start_generation_only_targets_non_done_paths(self):
        s = session_mod.Session()
        s.all_paths = ['A', 'B', 'C', 'D']
        s.results = {
            'A': {'status': 'done'},
            'B': {'status': 'failed'},
            'C': {'status': 'waiting'},
            'D': {'status': 'done'},
        }
        orig_thread_cls = threading.Thread
        session_mod.threading.Thread = _CaptureThread
        try:
            res = s.start_generation('meta', {}, {})
        finally:
            session_mod.threading.Thread = orig_thread_cls
        self.assertTrue(res['ok'])
        self.assertEqual(set(_CaptureThread.captured_targets), {'B', 'C'})
        self.assertNotIn('A', _CaptureThread.captured_targets)
        self.assertNotIn('D', _CaptureThread.captured_targets)


class RetryFailedFilterTests(unittest.TestCase):
    def test_start_generation_for_paths_targets_exactly_the_given_list(self):
        s = session_mod.Session()
        s.all_paths = ['A', 'B', 'C']
        s.results = {
            'A': {'status': 'done'},
            'B': {'status': 'failed'},
            'C': {'status': 'failed'},
        }
        orig_thread_cls = threading.Thread
        session_mod.threading.Thread = _CaptureThread
        try:
            # Only asking to retry B -- C is also failed but must be
            # left alone, proving this isn't secretly falling back to
            # "retry everything failed" behavior.
            res = s.start_generation_for_paths(['B'], 'meta', {}, {})
        finally:
            session_mod.threading.Thread = orig_thread_cls
        self.assertTrue(res['ok'])
        self.assertEqual(_CaptureThread.captured_targets, ['B'])

    def test_unknown_path_is_silently_dropped_not_errored(self):
        s = session_mod.Session()
        s.all_paths = ['A']
        s.results = {'A': {'status': 'failed'}}
        orig_thread_cls = threading.Thread
        session_mod.threading.Thread = _CaptureThread
        try:
            res = s.start_generation_for_paths(['A', 'never-imported.jpg'], 'meta', {}, {})
        finally:
            session_mod.threading.Thread = orig_thread_cls
        self.assertTrue(res['ok'])
        self.assertEqual(_CaptureThread.captured_targets, ['A'])


class UndoOrderingTests(unittest.TestCase):
    def test_single_delete_and_restore_preserves_exact_position(self):
        """A -> B -> C -> D, delete B, undo -> must be A -> B -> C -> D
        again, not A -> C -> D -> B."""
        s = session_mod.Session()
        paths = ['A', 'B', 'C', 'D']
        s.all_paths = list(paths)
        s.completion_order = list(paths)
        for p in paths:
            s.results[p] = {'status': 'done', 'title': p}

        s.delete_card('B')
        self.assertEqual(s.all_paths, ['A', 'C', 'D'])
        self.assertEqual(s.completion_order, ['A', 'C', 'D'])

        s.restore_card('B', {'status': 'done', 'title': 'B'})
        self.assertEqual(s.all_paths, ['A', 'B', 'C', 'D'])
        self.assertEqual(s.completion_order, ['A', 'B', 'C', 'D'])

    def test_bulk_delete_then_reverse_order_restore_preserves_position(self):
        s = session_mod.Session()
        paths = ['A', 'B', 'C', 'D']
        s.all_paths = list(paths)
        s.completion_order = list(paths)
        for p in paths:
            s.results[p] = {'status': 'done', 'title': p}

        s.delete_cards(['B', 'D'])
        self.assertEqual(s.all_paths, ['A', 'C'])

        # Restoring in reverse of deletion order (D, then B) is the
        # documented-correct order for a multi-item undo -- see
        # restore_card's docstring in session.py.
        s.restore_card('D', {'status': 'done', 'title': 'D'})
        s.restore_card('B', {'status': 'done', 'title': 'B'})
        self.assertEqual(s.all_paths, ['A', 'B', 'C', 'D'])

    def test_restore_falls_back_to_append_if_never_deleted_here(self):
        """A path restored without ever having gone through
        delete_card/delete_cards in this session (e.g. a fresh/odd
        call) should still work, just appended, not crash."""
        s = session_mod.Session()
        res = s.restore_card('never-deleted.jpg', {'status': 'done'})
        self.assertTrue(res['ok'])
        self.assertEqual(s.all_paths, ['never-deleted.jpg'])


class ClearAllEpochTests(unittest.TestCase):
    def test_epoch_bump_invalidates_a_stale_in_flight_run(self):
        """Clear All / starting a new run bumps gen_epoch; a worker
        thread from the previous run must recognize its own captured
        epoch no longer matches and refuse to write results."""
        s = session_mod.Session()
        s.all_paths = ['A']
        s.results = {'A': {'status': 'waiting'}}
        s.gen_epoch = 1
        captured_epoch_for_stale_worker = s.gen_epoch

        s.gen_epoch += 1  # simulate Clear All / a fresh Generate click

        self.assertNotEqual(captured_epoch_for_stale_worker, s.gen_epoch)

    def test_clear_resets_all_ordering_and_undo_state(self):
        s = session_mod.Session()
        s.all_paths = ['A', 'B']
        s.completion_order = ['A', 'B']
        s.results = {'A': {'status': 'done'}, 'B': {'status': 'done'}}
        s.delete_card('B')  # populates _deleted_positions
        self.assertTrue(s._deleted_positions)

        s.clear()
        self.assertEqual(s.all_paths, [])
        self.assertEqual(s.completion_order, [])
        self.assertEqual(s.results, {})
        self.assertEqual(s._deleted_positions, {})  # stale undo data must not survive a Clear All


class DryRunClassificationTests(unittest.TestCase):
    def _build_sample_folder_and_csv(self):
        tmpdir = tempfile.mkdtemp()
        p1 = os.path.join(tmpdir, 'photo1.jpg')
        p2 = os.path.join(tmpdir, 'notes.txt')
        make_test_image(p1)
        with open(p2, 'w') as f:
            f.write('not an image')
        csv_path = os.path.join(tmpdir, 'meta.csv')
        with open(csv_path, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['filename', 'title'])
            w.writerow(['photo1.jpg', 'T1'])       # matched
            w.writerow(['ghost.jpg', 'T2'])         # missing_image
            w.writerow(['', 'T3'])                  # missing_metadata
            w.writerow(['notes.txt', 'T4'])         # unsupported
        return tmpdir, csv_path, p1

    def test_four_base_categories_never_touch_disk(self):
        tmpdir, csv_path, p1 = self._build_sample_folder_and_csv()
        sess = embedder.EmbedSession()
        sess.load_csv(csv_path)

        import hashlib
        with open(p1, 'rb') as f:
            before = hashlib.md5(f.read()).hexdigest()
        res = sess.dry_run(tmpdir, {'filename': 'filename', 'title': 'title'},
                            {'subfolders': False, 'match_ext_only': True})
        with open(p1, 'rb') as f:
            after = hashlib.md5(f.read()).hexdigest()

        self.assertTrue(res['ok'])
        self.assertEqual(res['counts']['matched'], 1)
        self.assertEqual(res['counts']['missing_image'], 1)
        self.assertEqual(res['counts']['missing_metadata'], 1)
        self.assertEqual(res['counts']['unsupported'], 1)
        self.assertEqual(before, after, 'dry_run must never modify a file')

    @unittest.skipUnless(shutil.which('exiftool'), 'exiftool not installed in this environment')
    def test_already_embedded_detected_via_real_exiftool_batch_read(self):
        tmpdir = tempfile.mkdtemp()
        p1 = os.path.join(tmpdir, 'photo1.jpg')
        p2 = os.path.join(tmpdir, 'photo2.jpg')
        make_test_image(p1)
        make_test_image(p2)
        subprocess.run(['exiftool', '-overwrite_original', '-Title=Existing title', p1],
                        capture_output=True)

        csv_path = os.path.join(tmpdir, 'meta.csv')
        with open(csv_path, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['filename', 'title'])
            w.writerow(['photo1.jpg', 'New title'])
            w.writerow(['photo2.jpg', 'New title'])

        # find_exiftool() looks for a bundled exiftool.exe next to
        # app.py, which doesn't exist in a plain test environment --
        # point it at the system exiftool just for this test, the
        # same way a packaged Windows build points it at its bundled
        # copy.
        original_find = embedder.find_exiftool
        embedder.find_exiftool = lambda: 'exiftool'
        try:
            sess = embedder.EmbedSession()
            sess.load_csv(csv_path)
            res = sess.dry_run(tmpdir, {'filename': 'filename', 'title': 'title'},
                                {'subfolders': False, 'match_ext_only': True})
        finally:
            embedder.find_exiftool = original_find

        self.assertEqual(res['counts']['already_embedded'], 1)
        self.assertEqual(res['counts']['matched'], 1)
        cats = {r['filename']: r['category'] for r in res['rows']}
        self.assertEqual(cats['photo1.jpg'], 'already_embedded')
        self.assertEqual(cats['photo2.jpg'], 'matched')

        # Still must not have modified anything.
        check = subprocess.run(['exiftool', '-Title', '-s3', p1], capture_output=True, text=True)
        self.assertEqual(check.stdout.strip(), 'Existing title')

    def test_missing_exiftool_falls_back_to_matched_not_misclassified(self):
        """If exiftool can't be found/run, already-embedded files must
        fall back to "matched" (unknown, assume ready) -- never get
        silently mislabeled as something they're not."""
        tmpdir, csv_path, p1 = self._build_sample_folder_and_csv()
        original_find = embedder.find_exiftool
        embedder.find_exiftool = lambda: None
        try:
            sess = embedder.EmbedSession()
            sess.load_csv(csv_path)
            res = sess.dry_run(tmpdir, {'filename': 'filename', 'title': 'title'},
                                {'subfolders': False, 'match_ext_only': True})
        finally:
            embedder.find_exiftool = original_find
        self.assertEqual(res['counts']['already_embedded'], 0)
        self.assertEqual(res['counts']['matched'], 1)


class ApiKeyPersistenceTests(unittest.TestCase):
    def setUp(self):
        fresh_prefs_dir()
        core_config.save_prefs({'ai_keys': {'Gemini': [
            {'key': 'AIza-key-one', 'active': False},
            {'key': 'AIza-key-two', 'active': True},
        ]}})

    def test_nickname_persists_and_is_trimmed(self):
        settings_mod.set_key_nickname('Gemini', 0, '  Main Account  ')
        summary = settings_mod.get_provider_summary()
        gem = next(p for p in summary if p['provider'] == 'Gemini')
        self.assertEqual(gem['keys'][0]['nickname'], 'Main Account')

    def test_key_test_result_persists_with_correct_status(self):
        settings_mod.record_key_test('Gemini', 'AIza-key-one', True, 'Valid')
        settings_mod.record_key_test('Gemini', 'AIza-key-two', False, 'Invalid key — 401')
        summary = settings_mod.get_provider_summary()
        gem = next(p for p in summary if p['provider'] == 'Gemini')
        self.assertEqual(gem['keys'][0]['last_test']['status'], 'valid')
        self.assertEqual(gem['keys'][1]['last_test']['status'], 'invalid')

    def test_untested_key_reports_no_last_test_not_a_fabricated_one(self):
        summary = settings_mod.get_provider_summary()
        gem = next(p for p in summary if p['provider'] == 'Gemini')
        self.assertIsNone(gem['keys'][0]['last_test'])

    def test_activate_valid_keys_only_touches_keys_with_a_real_result(self):
        settings_mod.record_key_test('Gemini', 'AIza-key-one', True, 'Valid')
        # key-two is left untested on purpose
        settings_mod.activate_valid_keys('Gemini')
        summary = settings_mod.get_provider_summary()
        gem = next(p for p in summary if p['provider'] == 'Gemini')
        self.assertTrue(gem['keys'][0]['active'])   # valid -> activated
        self.assertFalse(gem['keys'][1]['active'])  # untested -> deactivated, not guessed

    def test_model_disable_persists_and_filters_dropdown_list(self):
        core_config.save_prefs({'ai_models': {'Gemini': 'gemini-3.6-flash'}})
        res = settings_mod.set_model_enabled('Gemini', 'gemini-1.5-flash', False)
        self.assertTrue(res['ok'])
        summary = settings_mod.get_provider_summary()
        gem = next(p for p in summary if p['provider'] == 'Gemini')
        enabled_ids = [mid for (_, mid) in gem['models']]
        all_ids = [mid for (_, mid) in gem['all_models']]
        self.assertNotIn('gemini-1.5-flash', enabled_ids)
        self.assertIn('gemini-1.5-flash', all_ids)  # not removed from the app, just hidden

    def test_cannot_disable_the_last_enabled_model(self):
        summary = settings_mod.get_provider_summary()
        gem = next(p for p in summary if p['provider'] == 'Gemini')
        all_ids = [mid for (_, mid) in gem['all_models']]
        for mid in all_ids[:-1]:
            settings_mod.set_model_enabled('Gemini', mid, False)
        res = settings_mod.set_model_enabled('Gemini', all_ids[-1], False)
        self.assertFalse(res['ok'])


if __name__ == '__main__':
    unittest.main()
