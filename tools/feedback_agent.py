#!/usr/bin/env python3
"""The agent that looks after this app, so the reviewer can ask for changes from the app itself.

It watches the reviewer's messages (the Feedback button on the queue). For each new message it runs
Claude Code in its own clone of this repository, where Claude may change the app, test it, commit on a
branch, and reply in the app with review.py feedback say. When Claude offers a commit with
--deploy and the reviewer taps the first choice ("Put it live"), this script, not Claude, tests that
commit, pushes it to GitHub when it has a key, moves the live checkout to it, and restarts the server
once nobody is saving anything. Claude never pushes, deploys, or restarts anything itself.

    python3 tools/feedback_agent.py --work DIR --live CHECKOUT [--service review-server]
        [--server http://127.0.0.1:8765] [--claude claude] [--push-key KEY --push-url URL]

DIR holds the agent's clone (DIR/repo), its notes (DIR/agent-state.json), and logs (DIR/runs/).
Needs Python 3.8+, git, and Claude Code signed in. Standard library only.
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
RULES = HERE.with_name('feedback-agent.md')
ALLOWED = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ls:*)',
           'Bash(grep:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(diff:*)', 'Bash(mkdir:*)', 'Bash(cat:*)']
PUT_LIVE = 'Put it live'


def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def log(*parts):
    print(now(), *parts, flush=True)


class Agent:
    def __init__(self, a):
        self.a = a
        self.work = Path(a.work).expanduser()
        self.repo = self.work / 'repo'
        self.live = Path(a.live).expanduser()
        self.state_path = self.work / 'agent-state.json'
        self.state = self.load()
        state_file = Path(a.state).expanduser() if a.state else Path.home() / '.config' / 'review-server' / 'replaced.json'
        self.token_path = state_file.parent / 'agent-token'

    # ------------------------------------------------------------ talking to the app

    def call(self, path, body=None):
        headers = {'X-Review': '1', 'Content-Type': 'application/json'}
        if self.token_path.is_file():
            headers['X-Review-Agent'] = self.token_path.read_text().strip()
        req = urllib.request.Request(self.a.server.rstrip('/') + path, data=json.dumps(body).encode() if body is not None else None,
                                     method='POST' if body is not None else 'GET', headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def say(self, text, **extra):
        return self.call('/api/feedback', dict({'text': text}, **extra))['message']

    def status(self, state, note=''):
        try:
            self.call('/api/feedback/agent', {'state': state, 'note': note})
        except OSError as e:
            log('could not reach the server:', e)

    # ------------------------------------------------------------ memory

    def load(self):
        try:
            data = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            data = {}
        data.setdefault('seen', None)          # the last of the reviewer's messages already given to Claude
        data.setdefault('answers', [])         # questions whose answers have been acted on
        data.setdefault('session', None)       # Claude's session, resumed so it remembers the conversation
        return data

    def save(self):
        self.work.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.state, indent=2))
        tmp.replace(self.state_path)

    # ------------------------------------------------------------ git and shell

    def run(self, cmd, cwd=None, timeout=600, env=None, check=True):
        r = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout,
                           env=dict(os.environ, **(env or {})))
        if check and r.returncode:
            raise RuntimeError('%s failed: %s' % (' '.join(map(str, cmd[:3])), (r.stderr or r.stdout).strip()[-800:]))
        return r

    def ensure_clone(self):
        if (self.repo / '.git').is_dir():
            return
        self.work.mkdir(parents=True, exist_ok=True)
        url = self.run(['git', '-C', str(self.live), 'remote', 'get-url', 'origin']).stdout.strip()
        self.run(['git', 'clone', '-q', url, str(self.repo)], timeout=900)
        log('cloned', url, 'into', self.repo)

    # ------------------------------------------------------------ the loop

    def once(self):
        data = self.call('/api/feedback')
        msgs = data['messages']
        ids = [m['id'] for m in msgs]
        # Taps on "Put it live" are carried out here, before Claude sees anything else.
        for m in msgs:
            if m.get('deploy') and m.get('answer') == PUT_LIVE and m['id'] not in self.state['answers']:
                self.state['answers'].append(m['id'])
                self.save()
                self.deploy(m['deploy'])
        start = ids.index(self.state['seen']) + 1 if self.state['seen'] in ids else 0
        new = [m for m in msgs[start:] if m['from'] == 'you']
        answered = [m for m in msgs if m['from'] == 'agent' and m.get('answer') and m['id'] not in self.state['answers']]
        if not new and not answered:
            return False
        self.state['answers'] += [m['id'] for m in answered]
        self.state['seen'] = ids[-1]
        self.save()
        self.ask_claude(new, answered, msgs)
        return True

    def ask_claude(self, new, answered, msgs):
        note = (new[-1]['text'] if new else 'your answer: ' + answered[-1]['answer']).replace('\n', ' ')
        self.status('working', note[:120])
        lines = ['New since you last looked:']
        lines += ['- The reviewer wrote (%s): %s' % (m['at'], m['text']) for m in new]
        lines += ['- The reviewer answered your question "%s": %s' % (m['text'][:200], m['answer']) for m in answered]
        lines += ['', 'The conversation so far, oldest first (most recent 16 messages):']
        lines += ['- %s, %s: %s%s' % (m['at'], 'you (the agent)' if m['from'] == 'agent' else 'the reviewer', m['text'][:1500],
                                      ' [choices: %s; answer: %s]' % (' | '.join(m['choices']), m.get('answer') or 'not yet')
                                      if m.get('choices') else '') for m in msgs[-16:]]
        prompt = '\n'.join(lines)
        before = sum(1 for m in msgs if m['from'] == 'agent')
        rules = RULES.read_text() if RULES.is_file() else ''
        rules = rules.replace('{server}', self.a.server).replace('{live}', str(self.live))
        # dontAsk: anything not on the list is refused, never asked about, since nobody is there to answer.
        cmd = [self.a.claude, '-p', prompt, '--output-format', 'json', '--permission-mode', 'dontAsk',
               '--append-system-prompt', rules, '--allowedTools', ' '.join(ALLOWED)]
        if self.a.max_turns:
            cmd += ['--max-turns', str(self.a.max_turns)]
        if self.a.model:
            cmd += ['--model', self.a.model]
        if self.state.get('session'):
            cmd += ['--resume', self.state['session']]
        runs = self.work / 'runs'
        runs.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        try:
            self.ensure_clone()
            self.run(['git', 'fetch', '-q', 'origin'], cwd=self.repo, check=False, timeout=300)
            r = self.run(cmd, cwd=self.repo, timeout=self.a.timeout, check=False, env={'PATH': self.a.path + os.pathsep + os.environ.get('PATH', '')})
            (runs / (stamp + '.json')).write_text(r.stdout or r.stderr or '')
            try:
                out = json.loads(r.stdout)
            except ValueError:
                out = {}
            if r.returncode and self.state.get('session') and not out:
                self.state['session'] = None          # a session that cannot be resumed: start a fresh one next time
            if out.get('session_id'):
                self.state['session'] = out['session_id']
            self.save()
            after = sum(1 for m in self.call('/api/feedback')['messages'] if m['from'] == 'agent')
            if after == before:                       # Claude did not reply in the app itself
                text = (out.get('result') or '').strip() or 'I could not finish that (%s). The log is %s.' % (
                    'exit %d' % r.returncode, runs / (stamp + '.json'))
                self.say(text[:4000])
        except Exception as e:                        # keep looking after the app whatever happens in one run
            log('run failed:', e)
            try:
                self.say('Something went wrong while I worked on that: %s' % str(e)[:500])
            except OSError:
                pass
        finally:
            self.status('idle')

    # ------------------------------------------------------------ putting a commit live

    def server_quiet(self):
        """No highlight, text, or voice note was saved in the last minute."""
        if not self.a.service:
            return True
        r = self.run(['journalctl', '--user', '-u', self.a.service, '--since', '-60 s', '--no-pager'], check=False)
        return not any(('"PUT ' in line or '"POST ' in line or '"DELETE ' in line) and '/api/feedback' not in line
                       for line in r.stdout.splitlines())

    def deploy(self, sha):
        self.status('working', 'putting %s live' % sha[:7])
        try:
            self.ensure_clone()
            self.run(['git', 'fetch', '-q', 'origin'], cwd=self.repo, timeout=300)
            full = self.run(['git', 'rev-parse', '--verify', sha + '^{commit}'], cwd=self.repo).stdout.strip()
            live_head = self.run(['git', 'rev-parse', 'HEAD'], cwd=self.live).stdout.strip()
            if self.run(['git', 'merge-base', '--is-ancestor', live_head, full], cwd=self.repo, check=False).returncode:
                self.say('I did not put %s live: the live app has moved on since I made it. Tell me to try again and I '
                         'will rebuild it on top of the newest version.' % full[:7])
                return
            if self.run(['git', 'status', '--porcelain'], cwd=self.live).stdout.strip():
                self.say('I did not put %s live: the live checkout has changes nobody committed.' % full[:7])
                return
            # Test exactly this commit, in a scratch checkout of the agent's clone.
            scratch = self.work / 'deploy-check'
            if scratch.exists():
                self.run(['git', 'worktree', 'remove', '--force', str(scratch)], cwd=self.repo, check=False)
            self.run(['git', 'worktree', 'add', '-q', '--detach', str(scratch), full], cwd=self.repo)
            try:
                t = self.run([sys.executable, '-m', 'unittest', '-q', 'test_review'], cwd=scratch, timeout=900, check=False)
            finally:
                self.run(['git', 'worktree', 'remove', '--force', str(scratch)], cwd=self.repo, check=False)
            if t.returncode:
                self.say('I did not put %s live: its tests failed.\n%s' % (full[:7], (t.stderr or t.stdout)[-1500:]))
                return
            pushed = ''
            if self.a.push_key and self.a.push_url:
                ssh = 'ssh -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new' % self.a.push_key
                p = self.run(['git', 'push', '-q', self.a.push_url, full + ':refs/heads/main'], cwd=self.repo,
                             env={'GIT_SSH_COMMAND': ssh}, check=False, timeout=300)
                if p.returncode:
                    self.say('I did not put %s live: GitHub would not take it (%s).' % (full[:7], (p.stderr or p.stdout).strip()[-400:]))
                    return
                pushed = ' It is on GitHub too.'
            else:
                pushed = ' GitHub was not updated: I have no key for it.'
            self.run(['git', 'fetch', '-q', str(self.repo), '+refs/heads/*:refs/remotes/agent/*'], cwd=self.live, timeout=300)
            if pushed.startswith(' It is'):
                self.run(['git', 'fetch', '-q', 'origin'], cwd=self.live, timeout=300, check=False)
            self.run(['git', 'merge', '-q', '--ff-only', full], cwd=self.live)
            waited = 0
            while not self.server_quiet() and waited < 600:
                self.status('working', 'waiting for a quiet minute to restart')
                time.sleep(15)
                waited += 15
            if self.a.service:
                if waited >= 600:
                    self.say('%s is in the live checkout, but the server was busy for ten minutes, so I have not restarted it. '
                             'It will take effect at the next restart.' % full[:7])
                    return
                self.run(['systemctl', '--user', 'restart', self.a.service])
                time.sleep(4)
                active = self.run(['systemctl', '--user', 'is-active', self.a.service], check=False).stdout.strip()
                if active != 'active':
                    self.say('I restarted the server with %s and it is %s. Please tell whoever looks after the server.' % (full[:7], active))
                    return
            self.say('%s is live. Reload the page to see it.%s' % (full[:7], pushed))
            self.reexec_if_changed()
        except Exception as e:
            log('deploy failed:', e)
            self.say('Putting %s live failed: %s' % (sha[:7], str(e)[:600]))
        finally:
            self.status('idle')

    def reexec_if_changed(self):
        """This script runs from the live checkout; after an update, run the new version."""
        live_copy = self.live / 'tools' / 'feedback_agent.py'
        if live_copy.resolve() == HERE and live_copy.read_bytes() != self.started_with:
            log('restarting with the new version of this script')
            os.execv(sys.executable, [sys.executable, str(HERE)] + sys.argv[1:])

    def serve(self):
        self.started_with = HERE.read_bytes()
        log('looking after the app at', self.a.server, '; work in', self.work)
        while True:
            try:
                self.status('idle')
                busy = self.once()
            except OSError as e:
                log('server not reachable:', e)
                busy = False
            time.sleep(1 if busy else self.a.interval)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--work', required=True, help='folder for the agent\'s clone, notes, and logs')
    ap.add_argument('--live', required=True, help='the checkout the server runs from')
    ap.add_argument('--service', default='', help='the systemd user service to restart after putting a change live')
    ap.add_argument('--server', default='http://127.0.0.1:8765')
    ap.add_argument('--state', help='the server\'s state file, to find the agent token (default ~/.config/review-server/replaced.json)')
    ap.add_argument('--claude', default='claude')
    ap.add_argument('--model', default='')
    ap.add_argument('--max-turns', type=int, default=0, help='limit Claude\'s turns, if this Claude Code version takes --max-turns')
    ap.add_argument('--timeout', type=int, default=3600, help='seconds one piece of work may take')
    ap.add_argument('--interval', type=int, default=20, help='seconds between looks at the messages')
    ap.add_argument('--path', default='', help='folders to put first on PATH for Claude (for example a newer node)')
    ap.add_argument('--push-key', default='', help='an SSH key that may push to the repository (a deploy key)')
    ap.add_argument('--push-url', default='', help='where to push, for example git@github.com:owner/repo.git')
    ap.add_argument('--once', action='store_true', help='look once and stop (for testing)')
    a = ap.parse_args(argv)
    agent = Agent(a)
    if a.once:
        agent.started_with = HERE.read_bytes()
        return 0 if agent.once() is not None else 1
    agent.serve()


if __name__ == '__main__':
    sys.exit(main())
