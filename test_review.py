#!/usr/bin/env python3
"""Tests for versions and replaced items: python3 -m unittest -v test_review (standard library only)."""
import contextlib
import http.server
import io
import json
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import review

PDF = b'%PDF-1.4\n% test\n%%EOF\n'


class Quiet:
    """Stands in for the transcriber."""
    ok = False

    def add(self, path):
        pass


def files(folder):
    return sorted(str(p.relative_to(folder)) for p in Path(folder).rglob('*') if p.is_file())


class Base(unittest.TestCase):
    auto_close = True

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / 'repo' / 'Applications' / 'App'
        self.repo.mkdir(parents=True)
        self.inbox = self.tmp / 'inbox'
        self.inbox.mkdir()
        self.state = self.tmp / 'state' / 'replaced.json'
        self.start()

    def start(self):
        self.store = review.Store([self.tmp / 'repo', self.inbox], self.inbox, Quiet(),
                                  auto_close=self.auto_close, state=self.state)
        handler = review.make_handler(self.store, '')
        handler.log_message = lambda *args: None
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:%d' % self.server.server_address[1]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def tearDown(self):
        self.stop()
        shutil.rmtree(str(self.tmp))

    def queue(self, name, where=None, **meta):
        """Like review.py queue: writes the item folder directly."""
        meta.setdefault('title', name)
        item = review.make_item(where or self.repo, name, PDF, meta)
        return review.item_id(item), item

    def call(self, method, path, body=None, ctype='application/json'):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={'X-Review': '1', 'Content-Type': ctype})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def items(self):
        return {s['id']: s for s in self.call('GET', '/api/items')[1]['items']}

    def highlight(self, iid):
        h = {'n': 1, 'id': 'h1', 'tag': 'change', 'page': 1, 'text': 'word', 'note': '',
             'rects': [{'page': 1, 'x': 1, 'y': 1, 'w': 5, 'h': 5}]}
        code, _ = self.call('PUT', '/api/items/%s/highlights' % iid, {'base_version': 0, 'max_n': 1, 'highlights': [h]})
        self.assertEqual(code, 200)


class Names(unittest.TestCase):
    def test_examples(self):
        nv = review.name_version
        self.assertEqual(nv('Lab_grant_application_v8_review_highlighted.pdf'), ('Lab_grant_application', 8))
        self.assertEqual(nv('Lab_grant_application_v9.pdf'), ('Lab_grant_application', 9))
        self.assertEqual(nv('Lab_grant_cover_email_v8.pdf'),
                         ('Lab_grant_cover_email', 8))
        self.assertEqual(nv('Lab_research_plan_v4_PREVIEW.pdf'), ('Lab_research_plan', 4))

    def test_edges(self):
        nv = review.name_version
        self.assertEqual(nv('Budget_v2_notes_v3.pdf'), ('Budget_v2_notes', 3))     # the last one counts
        self.assertEqual(nv('Plan_v12'), ('Plan', 12))
        self.assertEqual(nv('Letter.pdf'), ('Letter', None))
        self.assertEqual(nv('Plan_v2b.pdf'), ('Plan_v2b', None))                  # not followed by _, extension, or end
        self.assertEqual(nv('Plan_version2.pdf'), ('Plan_version2', None))

    def test_overrides(self):
        dv = review.doc_version
        self.assertEqual(dv({'pdf': 'A_v3.pdf'}), ('A', 3))
        self.assertEqual(dv({'pdf': 'A_v3.pdf', 'doc': 'B'}), ('B', 3))
        self.assertEqual(dv({'pdf': 'A_v3.pdf', 'version': 7}), ('A', 7))
        self.assertEqual(dv({'pdf': 'Letter.pdf', 'doc': 'B', 'version': 2}), ('B', 2))
        self.assertEqual(dv({'pdf': 'A_v3.pdf', 'version': 'junk'}), ('A', 3))


class Versions(Base):
    def test_one_to_three(self):
        v1, p1 = self.queue('Plan_v1.pdf')
        v2, p2 = self.queue('Plan_v2_review.pdf')
        before = {p: files(p) for p in (p1, p2)}
        v3, p3 = self.queue('Plan_v3.pdf')
        closed = self.store.sweep()
        self.assertEqual(sorted(s['id'] for s, _ in closed), sorted([v1, v2]))
        items = self.items()
        for iid, version in ((v1, 1), (v2, 2), (v3, 3)):
            self.assertEqual((items[iid]['doc'], items[iid]['version']), ('Plan', version))
        self.assertEqual([items[v]['status'] for v in (v1, v2, v3)], ['superseded', 'superseded', 'waiting'])
        self.assertEqual(items[v1]['superseded_by'], v3)
        self.assertEqual(items[v1]['superseded_version'], 3)
        self.assertTrue(items[v1]['superseded_auto'])
        self.assertIsNone(items[v3]['superseded_by'])
        done = json.loads((p1 / 'done.json').read_text())
        self.assertEqual(done['superseded_by'], v3)
        self.assertIn('superseded_at', done)
        self.assertNotIn('done_at', done)
        for p, was in before.items():                          # only done.json is added
            self.assertEqual(files(p), sorted(was + ['done.json']))
        self.assertEqual(self.store.sweep(), [])               # nothing more to do
        self.assertEqual(json.loads(self.state.read_text())[v1]['version'], 3)

    def test_upload_closes_at_once(self):
        v1, _ = self.queue('Plan_v1.pdf', where=self.inbox)
        code, r = self.call('POST', '/api/queue?title=Plan%20v2&filename=Plan_v2.pdf', PDF, 'application/pdf')
        self.assertEqual(code, 200)
        self.assertEqual((r['item']['doc'], r['item']['version']), ('Plan', 2))
        self.assertEqual(self.items()[v1]['status'], 'superseded')

    def test_marked_versions_stay(self):
        v1, _ = self.queue('Plan_v1.pdf')
        v2, p2 = self.queue('Plan_v2.pdf')
        v3, _ = self.queue('Plan_v3.pdf')
        v4, _ = self.queue('Plan_v4.pdf')
        self.highlight(v1)
        code, _ = self.call('POST', '/api/items/%s/audio?highlight=h1' % v2, b'not really audio', 'audio/mp4')
        self.assertEqual(code, 200)
        self.assertEqual([s['id'] for s, _ in self.store.sweep()], [v3])
        items = self.items()
        self.assertEqual(items[v1]['status'], 'waiting')       # highlights
        self.assertEqual(items[v2]['status'], 'waiting')       # a voice note
        self.assertEqual(items[v2]['voice_notes'], 1)
        # Mark older done closes them as replaced, not done.
        for iid in (v1, v2):
            code, r = self.call('POST', '/api/items/%s/done' % iid, {'superseded_by': v4})
            self.assertEqual(code, 200)
            self.assertEqual(r['item']['status'], 'superseded')
            self.assertFalse(r['item']['superseded_auto'])
        self.assertEqual(self.items()[v1]['count'], 1)         # the highlights are still there

    def test_mark_older_done_checks(self):
        v1, _ = self.queue('Plan_v1.pdf')
        v2, _ = self.queue('Plan_v2.pdf')
        o1, _ = self.queue('Other_v5.pdf')
        n1, _ = self.queue('Notes.pdf')
        self.assertEqual(self.call('POST', '/api/items/%s/done' % v2, {'superseded_by': v1})[0], 400)   # lower
        self.assertEqual(self.call('POST', '/api/items/%s/done' % v1, {'superseded_by': o1})[0], 400)   # other document
        self.assertEqual(self.call('POST', '/api/items/%s/done' % n1, {'superseded_by': v2})[0], 400)   # no version
        self.assertEqual(self.call('POST', '/api/items/%s/done' % v1, {'superseded_by': 'nosuchitem'})[0], 404)
        self.assertEqual(self.call('POST', '/api/items/%s/done' % v1, {})[0], 200)                      # the reviewer's Done
        self.assertEqual(self.call('POST', '/api/items/%s/done' % v1, {'superseded_by': v2})[0], 409)
        self.assertEqual(self.items()[v1]['status'], 'done')

    def test_done_items_stay_done(self):
        v1, _ = self.queue('Plan_v1.pdf')
        self.assertEqual(self.call('POST', '/api/items/%s/done' % v1, {})[0], 200)
        self.queue('Plan_v2.pdf')
        self.store.sweep()
        self.assertEqual(self.items()[v1]['status'], 'done')

    def test_same_version_stays_separate(self):
        v1, _ = self.queue('Plan_v1.pdf')
        a, _ = self.queue('Plan_v2.pdf')
        b, _ = self.queue('Plan_v2_for_collaborator.pdf')
        self.store.sweep()
        items = self.items()
        self.assertEqual((items[a]['status'], items[b]['status']), ('waiting', 'waiting'))
        self.assertEqual(items[v1]['status'], 'superseded')
        self.assertIn(items[v1]['superseded_by'], (a, b))
        self.assertEqual(self.call('POST', '/api/items/%s/done' % a, {'superseded_by': b})[0], 400)

    def test_doc_override(self):
        old, _ = self.queue('Plan_v3.pdf')
        mine, _ = self.queue('Plan_v1.pdf', doc='Plan for collaborator')    # same file stem, another document
        with contextlib.redirect_stdout(io.StringIO()) as out:       # review.py queue --doc --version
            pdf = self.tmp / 'Letter_to_reviewers.pdf'
            pdf.write_bytes(PDF)
            review.main(['queue', str(pdf), '--title', 'Letter', '--into', str(self.repo), '--doc', 'Plan', '--version', '4'])
        req = json.loads((Path(out.getvalue().strip()) / 'request.json').read_text())
        self.assertEqual((req['doc'], req['version']), ('Plan', 4))
        code, r = self.call('POST', '/api/queue?title=x&filename=Draft_v9.pdf&doc=Plan%20for%20collaborator&version=2', PDF, 'application/pdf')
        self.assertEqual((code, r['item']['doc'], r['item']['version']), (200, 'Plan for collaborator', 2))
        self.assertEqual(self.call('POST', '/api/queue?title=x&filename=a.pdf&version=two', PDF, 'application/pdf')[0], 400)
        self.store.sweep()
        items = self.items()
        self.assertEqual(items[old]['status'], 'superseded')         # by the letter, version 4 of Plan
        self.assertEqual(items[old]['superseded_version'], 4)
        self.assertEqual(items[mine]['status'], 'superseded')        # by Draft_v9.pdf, version 2 of "Plan for collaborator"
        self.assertEqual(items[mine]['superseded_version'], 2)

    def test_reopen(self):
        v1, p1 = self.queue('Plan_v1.pdf')
        v2, _ = self.queue('Plan_v2.pdf')
        self.store.sweep()
        code, r = self.call('DELETE', '/api/items/%s/done' % v1)
        self.assertEqual((code, r['item']['status']), (200, 'waiting'))
        self.assertFalse((p1 / 'done.json').exists())
        self.assertEqual(self.store.sweep(), [])                     # not closed again
        self.stop()
        self.start()                                                 # nor after a restart
        self.assertEqual(self.store.sweep(), [])
        self.assertEqual(self.items()[v1]['status'], 'waiting')
        v3, _ = self.queue('Plan_v3.pdf')                            # a still newer version closes it again
        self.assertEqual(sorted(s['id'] for s, _ in self.store.sweep()), sorted([v1, v2]))
        self.assertEqual(self.items()[v1]['superseded_by'], v3)

    def test_reopen_by_deleting_done_json(self):
        v1, p1 = self.queue('Plan_v1.pdf')
        self.queue('Plan_v2.pdf')
        self.store.sweep()
        (p1 / 'done.json').unlink()
        self.assertEqual(self.store.sweep(), [])
        self.assertEqual(self.items()[v1]['status'], 'waiting')

    def test_unreadable_files(self):
        bad, p = self.queue('Plan_v1.pdf')
        (p / 'request.json').write_text('{not json')
        v1, _ = self.queue('Other_v1.pdf')
        self.queue('Other_v2.pdf')
        self.assertEqual([s['id'] for s, _ in self.store.sweep()], [v1])
        self.stop()
        self.state.write_text('{not json')
        self.start()
        self.assertEqual(self.store.replaced, {})

    def test_no_version(self):
        n1, p1 = self.queue('Notes.pdf')
        n2, _ = self.queue('Notes.pdf')
        v1, _ = self.queue('Notes_v1.pdf')
        v2, _ = self.queue('Notes_v2.pdf')
        self.assertEqual([s['id'] for s, _ in self.store.sweep()], [v1])
        items = self.items()
        self.assertEqual((items[n1]['doc'], items[n1]['version'], items[n1]['status']), ('Notes', None, 'waiting'))
        self.assertEqual(items[n2]['status'], 'waiting')
        self.assertEqual(self.call('POST', '/api/items/%s/done' % n1, {'superseded_by': v2})[0], 400)

    def test_list_show_pull(self):
        v1, p1 = self.queue('Plan_v1.pdf')
        v2, _ = self.queue('Plan_v2.pdf')
        self.store.sweep()
        roots = ['--root', str(self.tmp / 'repo')]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['list'] + roots)
        self.assertNotIn('Plan_v1', out.getvalue())
        self.assertIn('Plan, version 2', out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['list', '--all'] + roots)
        self.assertIn('superseded by v2', out.getvalue())
        self.assertIn('Plan, version 1', out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['show', str(p1)] + roots)
        self.assertIn('Superseded', out.getvalue())
        self.assertIn('did not mark this one done', out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['pull', '--server', self.base])
        self.assertIn('superseded by v2', out.getvalue())
        self.assertIn('waiting', out.getvalue())
        self.assertIn('Plan, version 1', out.getvalue())


class NoAutoClose(Base):
    auto_close = False

    def test_off(self):
        v1, _ = self.queue('Plan_v1.pdf')
        v2, _ = self.queue('Plan_v2.pdf')
        self.assertEqual(self.store.sweep(), [])
        self.assertEqual(self.call('POST', '/api/queue?title=x&filename=Plan_v3.pdf', PDF, 'application/pdf')[0], 200)
        items = self.items()
        self.assertEqual((items[v1]['status'], items[v2]['status']), ('waiting', 'waiting'))
        self.assertEqual(self.call('POST', '/api/items/%s/done' % v1, {'superseded_by': v2})[0], 200)   # by hand still works


if __name__ == '__main__':
    unittest.main()
