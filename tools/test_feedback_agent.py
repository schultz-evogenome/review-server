"""The app's agent end to end, with a stand-in for Claude Code: a message from the reviewer becomes a
commit and an offer in the app; a tap on "Put it live" tests that commit, pushes it, and moves the live
checkout to it. Run from the repository: python3 -m unittest -q tools.test_feedback_agent
Uses git and temporary folders only; no network, no Claude, no real server."""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
import review  # noqa: E402

# A stand-in for "claude -p": it records how it was called, commits a change on a branch, and offers it.
FAKE = textwrap.dedent('''\
    #!{python}
    import json, os, subprocess, sys
    args = sys.argv[1:]
    open(os.environ['FAKE_LOG'], 'a').write(json.dumps(args) + '\\n')
    prompt = args[args.index('-p') + 1]
    new = prompt.split('\\n\\n')[0]          # only what is new, not the conversation so far
    if 'Put the title in bold' in new:
        subprocess.run(['git', 'switch', '-q', '-c', 'agent/bold', 'origin/main'], check=True)
        open('NOTE.txt', 'w').write('bold\\n')
        subprocess.run(['git', 'add', 'NOTE.txt'], check=True)
        subprocess.run(['git', '-c', 'user.name=agent', '-c', 'user.email=agent@example.org', 'commit', '-qm', 'Bold title'], check=True)
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        subprocess.run([sys.executable, 'review.py', 'feedback', 'say', 'The title is bold now. Put it live?', '--deploy', sha,
                        '--choice', 'Put it live', '--choice', 'Not yet', '--server', os.environ['FAKE_SERVER'],
                        '--state', os.environ['FAKE_STATE']], check=True, capture_output=True)
        print(json.dumps({{'session_id': 'session-1', 'result': 'offered'}}))
    else:
        print(json.dumps({{'session_id': 'session-1', 'result': 'Noted: ' + prompt.splitlines()[1][:60]}}))
''')


def git(*args, cwd=None):
    return subprocess.run(['git'] + list(args), cwd=str(cwd) if cwd else None, check=True, capture_output=True, text=True).stdout.strip()


class Quiet:
    ok = False

    def add(self, path):
        pass


class FeedbackAgent(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        # "GitHub": a bare copy of this repository's files at one commit.
        src = self.tmp / 'src'
        shutil.copytree(str(REPO), str(src), ignore=shutil.ignore_patterns('.git', '__pycache__', 'node_modules', '.claude'))
        git('init', '-q', '-b', 'main', cwd=src)
        git('add', '-A', cwd=src)
        git('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-qm', 'start', cwd=src)
        self.github = self.tmp / 'github.git'
        git('clone', '-q', '--bare', str(src), str(self.github))
        self.live = self.tmp / 'live'
        git('clone', '-q', str(self.github), str(self.live))
        # The server, with its state (and the agent's token) in its own folder.
        self.state = self.tmp / 'state' / 'replaced.json'
        root = self.tmp / 'queue'
        root.mkdir()
        self.store = review.Store([root], None, Quiet(), auto_close=False, state=self.state)
        self.store.feedback.agent_token(create=True)
        handler = review.make_handler(self.store, '')
        handler.log_message = lambda *a: None
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:%d' % self.server.server_address[1]
        fake = self.tmp / 'claude'
        fake.write_text(FAKE.format(python=sys.executable))
        fake.chmod(0o755)
        self.log = self.tmp / 'claude-calls.jsonl'
        os.environ.update(FAKE_LOG=str(self.log), FAKE_SERVER=self.base, FAKE_STATE=str(self.state))
        self.args = ['--work', str(self.tmp / 'work'), '--live', str(self.live), '--server', self.base, '--state', str(self.state),
                     '--claude', str(fake), '--push-key', 'unused', '--push-url', str(self.github), '--interval', '1']

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(str(self.tmp))

    def post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method='POST',
                                     headers={'X-Review': '1', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    def messages(self):
        with urllib.request.urlopen(self.base + '/api/feedback', timeout=10) as r:
            return json.load(r)['messages']

    def agent(self):
        sys.path.insert(0, str(REPO / 'tools'))
        import feedback_agent
        return feedback_agent

    def test_a_message_becomes_an_offer_and_a_tap_puts_it_live(self):
        fa = self.agent()
        self.post('/api/feedback', {'text': 'Put the title in bold, please.'})
        self.assertEqual(fa.main(self.args + ['--once']), 0)
        msgs = self.messages()
        offer = msgs[-1]
        self.assertEqual((offer['from'], offer['choices'], offer['answer']), ('agent', ['Put it live', 'Not yet'], None))
        call = json.loads(self.log.read_text().splitlines()[0])
        self.assertIn('--allowedTools', call)
        self.assertEqual(call[call.index('--permission-mode') + 1], 'dontAsk')
        self.assertNotIn('--max-turns', call)
        self.assertNotIn('Bash(systemctl', ' '.join(call))           # Claude cannot restart anything
        self.assertIn('{live}'.format(live=self.live), call[call.index('--append-system-prompt') + 1])
        self.assertNotEqual(git('rev-parse', 'HEAD', cwd=self.live), offer['deploy'])   # nothing live until the tap
        self.post('/api/feedback/%s/answer' % offer['id'], {'choice': 'Put it live'})
        self.assertEqual(fa.main(self.args + ['--once']), 0)
        self.assertEqual(git('rev-parse', 'HEAD', cwd=self.live), offer['deploy'])
        self.assertEqual(git('rev-parse', 'main', cwd=self.github), offer['deploy'])
        self.assertIn('is live', self.messages()[-1]['text'])
        self.assertIn('on GitHub too', self.messages()[-1]['text'])
        # The second run resumed Claude's session; a plain note gets a reply even when Claude does not post one.
        self.post('/api/feedback', {'text': 'Thanks, looks good.'})
        fa.main(self.args + ['--once'])
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertIn('--resume', calls[-1])
        self.assertTrue(self.messages()[-1]['text'].startswith('Noted: - The reviewer wrote'), self.messages()[-1]['text'])

    def test_an_offer_older_than_the_live_app_is_not_put_live(self):
        fa = self.agent()
        self.post('/api/feedback', {'text': 'Put the title in bold, please.'})
        fa.main(self.args + ['--once'])
        offer = self.messages()[-1]
        # Meanwhile the live app moved on.
        Path(self.live, 'OTHER.txt').write_text('x\n')
        git('add', 'OTHER.txt', cwd=self.live)
        git('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-qm', 'other', cwd=self.live)
        moved = git('rev-parse', 'HEAD', cwd=self.live)
        self.post('/api/feedback/%s/answer' % offer['id'], {'choice': 'Put it live'})
        fa.main(self.args + ['--once'])
        self.assertEqual(git('rev-parse', 'HEAD', cwd=self.live), moved)
        self.assertIn('has moved on', self.messages()[-1]['text'])


if __name__ == '__main__':
    unittest.main()
