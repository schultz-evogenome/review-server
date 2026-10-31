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
        self.tmp = Path(tempfile.mkdtemp()).resolve()
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
            with e:
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


class TextFiles(Base):
    def detail(self, iid):
        return self.call('GET', '/api/items/%s' % iid)[1]

    def save(self, iid, text, base=None):
        base = self.detail(iid)['text']['sha256'] if base is None else base
        return self.call('PUT', '/api/items/%s/text' % iid, {'base_sha256': base, 'text': text})

    def queue_text(self, name, body=b'one\ntwo\n', **meta):
        meta.setdefault('title', name)
        item = review.make_item(self.repo, name, body, meta)
        return review.item_id(item), item

    def test_upload_kinds(self):
        for name, ok in (('a_v1.md', True), ('b.txt', True), ('c_v2.tex', True), ('d.docx', False)):
            code, r = self.call('POST', '/api/queue?title=t&filename=%s' % name, b'hello\n', 'text/plain')
            self.assertEqual(code, 200 if ok else 400, name)
            if ok:
                self.assertEqual((r['item']['kind'], r['item']['file'], r['item']['pdf']), ('text', name, ''))
        self.assertEqual(self.call('POST', '/api/queue?title=t&filename=e.md', b'\xff\xfe latin', 'text/plain')[0], 400)
        self.assertEqual(self.call('POST', '/api/queue?title=t&filename=f.md', b'a\0b', 'text/plain')[0], 400)
        self.assertEqual(self.call('POST', '/api/queue?title=t&filename=g.md', PDF, 'text/plain')[0], 400)
        self.assertEqual(self.call('POST', '/api/queue?title=t&filename=h.pdf', b'not a pdf', 'application/pdf')[0], 400)
        code, r = self.call('POST', '/api/queue?title=t&filename=i.pdf', PDF, 'application/pdf')
        self.assertEqual((code, r['item']['kind'], r['item']['pdf']), (200, 'pdf', 'i.pdf'))

    def test_edit_keeps_the_original(self):
        iid, p = self.queue_text('Plan_v1.md', 'caf\u00e9\n'.encode())
        self.assertEqual(self.detail(iid)['text']['current'], 'caf\u00e9\n')
        code, r = self.save(iid, 'caf\u00e9 au lait\n')
        self.assertEqual((code, r['text']['edited'], r['item']['edited']), (200, True, True))
        self.assertEqual((p / 'Plan_v1.md').read_text(encoding='utf-8'), 'caf\u00e9\n')
        self.assertEqual((p / 'edited' / 'Plan_v1.md').read_text(encoding='utf-8'), 'caf\u00e9 au lait\n')
        self.assertEqual(json.loads((p / 'request.json').read_text())['sha256'],
                         review.sha256_bytes('caf\u00e9\n'.encode()))
        d = self.detail(iid)['text']
        self.assertEqual((d['original'], d['current']), ('caf\u00e9\n', 'caf\u00e9 au lait\n'))
        self.assertIn('+caf\u00e9 au lait', d['diff'])

    def test_line_endings_and_no_newline_kept(self):
        iid, p = self.queue_text('a.txt', b'one\r\ntwo')
        self.assertEqual(self.save(iid, 'one\r\nTWO')[0], 200)
        self.assertEqual((p / 'edited' / 'a.txt').read_bytes(), b'one\r\nTWO')

    def test_undoing_every_edit_means_no_edits(self):
        iid, p = self.queue_text('Plan_v1.md')
        self.save(iid, 'changed\n')
        code, r = self.save(iid, 'one\ntwo\n')
        self.assertEqual((code, r['text']['edited'], r['item']['edited']), (200, False, False))
        self.assertFalse((p / 'edited').exists())

    def test_conflict(self):
        iid, p = self.queue_text('Plan_v1.md')
        base = self.detail(iid)['text']['sha256']
        self.assertEqual(self.save(iid, 'first device\n', base)[0], 200)
        code, r = self.save(iid, 'second device\n', base)
        self.assertEqual((code, r['text']['current']), (409, 'first device\n'))
        self.assertEqual((p / 'edited' / 'Plan_v1.md').read_text(), 'first device\n')

    def test_bad_saves(self):
        iid, _ = self.queue_text('Plan_v1.md')
        pdf, _ = self.queue('Paper_v1.pdf')
        self.assertEqual(self.call('PUT', '/api/items/%s/text' % iid, {'base_sha256': 'x'})[0], 400)
        self.assertEqual(self.save(iid, 'a\0b')[0], 400)
        self.assertEqual(self.save(iid, 'x' * (review.MAX_TEXT + 1))[0], 400)
        self.assertEqual(self.call('PUT', '/api/items/%s/text' % pdf, {'base_sha256': 'x', 'text': 'y'})[0], 400)

    def test_edited_older_version_stays(self):
        v1, _ = self.queue_text('Plan_v1.md')
        v2, _ = self.queue_text('Plan_v2.md')
        v3, _ = self.queue_text('Plan_v3.md')
        self.save(v1, 'my edits\n')
        self.assertEqual([s['id'] for s, _ in self.store.sweep()], [v2])
        items = self.items()
        self.assertEqual((items[v1]['status'], items[v2]['status'], items[v3]['status']), ('waiting', 'superseded', 'waiting'))
        code, r = self.call('POST', '/api/items/%s/done' % v1, {'superseded_by': v3})   # Mark older done, after asking
        self.assertEqual((code, r['item']['status'], r['item']['edited']), (200, 'superseded', True))

    def test_done_and_show(self):
        iid, p = self.queue_text('Plan_v1.md', title='The plan')
        self.save(iid, 'one\ntwo and more\n')
        self.assertEqual(self.call('POST', '/api/items/%s/done' % iid, {})[0], 200)
        self.assertTrue(json.loads((p / 'done.json').read_text())['edited'])
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['show', str(p), '--root', str(self.tmp / 'repo')])
        self.assertIn('Done ', out.getvalue())
        self.assertIn('+two and more', out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['pull', 'The plan', '--server', self.base])
        self.assertIn('+two and more', out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['list', '--all', '--root', str(self.tmp / 'repo')])
        self.assertIn('text, edited', out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            review.main(['show', str(p), '--json', '--root', str(self.tmp / 'repo')])
        self.assertEqual(json.loads(out.getvalue())['text']['current'], 'one\ntwo and more\n')

    def test_file_served_as_plain_text(self):
        iid, _ = self.queue_text('a.md', b'<script>alert(1)</script>\n')
        with urllib.request.urlopen(self.base + '/api/items/%s/file' % iid) as r:
            self.assertTrue(r.headers['Content-Type'].startswith('text/plain'))
            self.assertEqual(r.headers['X-Content-Type-Options'], 'nosniff')

    def test_image_references(self):
        refs = review.image_refs
        self.assertEqual(refs('a.md', '![x](fig/b.png "t")\n<img src="c.jpg">\n![](d.png)\n![](data:image/png;base64,AA)\n'
                                      '![](https://e.org/f.png)\n![again](fig/b.png)'), ['fig/b.png', 'c.jpg', 'd.png'])
        self.assertEqual(refs('a.tex', '% \\includegraphics{no}\n\\includegraphics[width=2in]{yes}\n50\\% \\includegraphics{two.pdf} % \\includegraphics{no2}'),
                         ['yes', 'two.pdf'])
        self.assertEqual(refs('a.txt', '![x](b.png)'), [])

    def write_doc(self, text):
        d = self.tmp / 'repo' / 'paper'
        (d / 'fig').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'repo' / '.git').mkdir(exist_ok=True)
        (d / 'fig' / 'one.png').write_bytes(b'\x89PNG one')
        (d / 'fig' / 'two.pdf').write_bytes(PDF)
        (self.tmp / 'repo' / 'shared.png').write_bytes(b'\x89PNG shared')
        (self.tmp / 'outside.png').write_bytes(b'\x89PNG secret')
        doc = d / 'doc_v1.tex'
        doc.write_text(text)
        return doc

    def test_markdown_with_raw_latex_figures(self):
        refs = review.image_refs('a.md', '![one](a.png)\n```{=latex}\n\\includegraphics[width=6.5in]{b.pdf}\n```\n50% ![three](c.jpg)\n')
        self.assertEqual(refs, ['a.png', 'b.pdf', 'c.jpg'])
        app = self.tmp / 'repo' / 'app'
        (app / 'drafts').mkdir(parents=True)
        (self.tmp / 'repo' / '.git').mkdir(exist_ok=True)
        (app / 'figures' / 'set_v1').mkdir(parents=True)
        (app / 'figures' / 'set_v2').mkdir()
        (app / 'figures' / 'set_v1' / 'one.pdf').write_bytes(PDF)
        (app / 'figures' / 'set_v1' / 'two.png').write_bytes(b'a')
        (app / 'figures' / 'set_v2' / 'two.png').write_bytes(b'b')
        text = '\\includegraphics{one.pdf}\n\\includegraphics{two.png}\n\\includegraphics{three.png}\n'
        doc = app / 'drafts' / 'plan_v1.md'
        doc.write_text(text)
        found = dict(review.find_images(doc, text))
        self.assertEqual(found['one.pdf'], app / 'figures' / 'set_v1' / 'one.pdf')
        self.assertIsNone(found['two.png'])          # two files with that name
        self.assertIsNone(found['three.png'])

    def test_queue_brings_images(self):
        doc = self.write_doc('\\graphicspath{{fig/}}\n\\includegraphics{one}\n\\includegraphics{two.pdf}\n'
                             '\\includegraphics{../shared.png}\n\\includegraphics{../../outside.png}\n\\includegraphics{gone}\n')
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(err):
            review.main(['queue', str(doc), '--title', 'Doc', '--into', str(self.repo)])
        item = Path(out.getvalue().strip())
        images = json.loads((item / 'request.json').read_text())['images']
        self.assertEqual(sorted(images), ['../shared.png', 'one', 'two.pdf'])     # nothing from outside the repository
        self.assertIn('outside.png', err.getvalue())
        self.assertIn('gone', err.getvalue())
        self.assertEqual((item / 'images' / images['one']).read_bytes(), b'\x89PNG one')
        iid = review.item_id(item)
        self.assertEqual(self.detail(iid)['text']['images'], images)
        with urllib.request.urlopen(self.base + '/api/items/%s/images/%s' % (iid, images['one'])) as r:
            self.assertEqual((r.headers['Content-Type'], r.read()), ('image/png', b'\x89PNG one'))

    def test_push_sends_images(self):
        doc = self.write_doc('\\includegraphics{fig/one.png}\n')
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(err):
            review.main(['push', str(doc), '--server', self.base, '--title', 'Doc'])
        self.assertIn('Sent image fig/one.png', out.getvalue())
        s = [s for s in self.items().values() if s['title'] == 'Doc'][0]
        self.assertEqual(list(self.detail(s['id'])['text']['images']), ['fig/one.png'])

    def test_add_image_checks(self):
        iid, p = self.queue_text('a.md', b'![x](b.png)\n')
        pdf, _ = self.queue('Paper_v1.pdf')
        post = lambda i, q, body=b'data': self.call('POST', '/api/items/%s/images?%s' % (i, q), body, 'image/png')
        self.assertEqual(post(pdf, 'ref=b.png&filename=b.png')[0], 400)
        self.assertEqual(post(iid, 'ref=b.png&filename=b.exe')[0], 400)
        self.assertEqual(post(iid, 'filename=b.png')[0], 400)
        self.assertEqual(post(iid, 'ref=b.png&filename=b.png', b'')[0], 400)
        code, r = post(iid, 'ref=b.png&filename=../../evil.png')
        self.assertEqual((code, r['images']), (200, {'b.png': '001_evil.png'}))
        self.assertTrue((p / 'images' / '001_evil.png').is_file())
        code, r = post(iid, 'ref=b.png&filename=other.png', b'new')                # replacing keeps its place
        self.assertEqual(r['images'], {'b.png': '001_evil.png'})
        self.assertEqual((p / 'images' / '001_evil.png').read_bytes(), b'new')
        self.assertEqual(self.call('GET', '/api/items/%s/images/..%%2Frequest.json' % iid)[0], 404)
        self.assertEqual(self.call('GET', '/api/items/%s/images/nope.png' % iid)[0], 404)

    def test_svg_is_sandboxed(self):
        iid, _ = self.queue_text('a.md', b'![x](b.svg)\n')
        self.call('POST', '/api/items/%s/images?ref=b.svg&filename=b.svg' % iid, b'<svg/>', 'image/svg+xml')
        with urllib.request.urlopen(self.base + '/api/items/%s/images/001_b.svg' % iid) as r:
            self.assertIn('sandbox', r.headers['Content-Security-Policy'])
            self.assertEqual(r.headers['Content-Type'], 'image/svg+xml')


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
