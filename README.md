# review-server

A review queue for PDFs. Agents add a PDF to the queue. You open the queue on an iPad, highlight text by selecting it or by drawing over it with an Apple Pencil, tag each highlight "change" or "discuss," dictate a note or record a voice note if you want one, and tap Done. Agents then read the numbered highlights and match them with what you tell them.

Each queued item is a folder of plain files. Agents on the server's machine write the folder next to the document it reviews, so git carries it with the rest of the repository. Agents elsewhere send the PDF to the server, which keeps it in its inbox folder.

One Python file, standard library only, plus a static page.

## Start it

Run it on a machine that stays on, so the queue is there wherever you are, and reach it from your devices over [Tailscale](https://tailscale.com):

```
git clone https://github.com/schultz-evogenome/review-server ~/review-server
python3 ~/review-server/review.py serve --root ~/projects --inbox ~/review
tailscale serve --bg 8765
```

The server listens only on its own machine (port 8765). `tailscale serve` passes it on to your tailnet and prints the address, such as `https://<machine>.<your-tailnet>.ts.net/`. Open that on the iPad (with the Tailscale app connected) or on a laptop. Nothing is open to the internet, and no token is needed. If `tailscale serve` says access is denied, run it with `sudo`. If it asks you to turn on HTTPS certificates for the tailnet, follow the link it prints.

In Safari, Share › Add to Home Screen makes it open like an app.

The server shows items from every folder named `review_queue` under its roots (give `--root` once for each folder to search). `--inbox` adds one more root, where PDFs sent from elsewhere go.

Without `tailscale serve`, add `--lan` to the serve command instead. The server then listens on the machine's network addresses too, prints an address with a token for other devices, and keeps that token in `~/.config/review-server/token`.

To start it with the machine, use a systemd user service:

```
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/review-server.service <<'EOF'
[Unit]
Description=Review queue

[Service]
ExecStart=/usr/bin/python3 %h/review-server/review.py serve --root %h/projects --inbox %h/review
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now review-server
sudo loginctl enable-linger "$USER"
```

After that, `systemctl --user restart review-server` restarts it, and `journalctl --user -u review-server -f` shows what it is doing. `tailscale serve --bg` is remembered across reboots. To update, run `git -C ~/review-server pull` and restart.

To stop the server from closing older versions by itself (see Versions below), add `--no-auto-close` to the end of the `ExecStart` line, then run `systemctl --user daemon-reload` and `systemctl --user restart review-server`.

## Voice notes

Each highlight can carry voice notes recorded on the page with the device's own microphone. They are saved in the item folder's `audio/` folder. To have the server turn them into text, install faster-whisper for the Python that runs the server (the one in `ExecStart`), then restart it:

```
python3 -m pip install faster-whisper
systemctl --user restart review-server
```

The server then loads the speech model when the first clip arrives, keeps it in memory while clips keep coming, and unloads it after 15 minutes without one. The first time, it downloads the model (`small.en`, about 500 MB) into `~/.cache/huggingface`. It uses the graphics card if one is usable, otherwise the processor. To use another model, add `Environment=REVIEW_WHISPER_MODEL=base.en` (faster) or `medium.en` (more accurate) under `[Service]` in the service file. Without faster-whisper, clips are saved and play back, but have no text. The audio never leaves the server's machine.

## Send something to review

- **You, from any device:** tap Add PDF on the queue page and pick a file.
- **An agent on the server's machine:** `review.py queue` (below). The item sits next to its draft and is committed with it.
- **An agent anywhere on your tailnet:** `review.py push` (below), or the same request with curl. The item goes to the inbox at once, with no sync.

## Use it on the iPad

- **Queue.** Items waiting for you, oldest first, with the note from whoever queued them. Each document has one card, showing its newest version. Finished items are under Done; older versions that a newer one replaced are under Replaced.
- **Older versions.** If older versions of a document are still waiting, its card says so ("2 older versions"). Tap that line to list them; each still opens. **Mark older done** closes them. If any of them has your highlights or voice notes, the card lists those and asks first. Closed versions go to Replaced, labeled with the version that replaced them, not to Done.
- **Select** (the default). Touch and hold to select text, drag the handles, then tap Change or Discuss at the bottom of the screen.
- **Change pen** and **Discuss pen.** Draw over text with the Pencil. Your finger still scrolls. Without a Pencil, turn on Finger draws, and turn it off again to scroll.
- **Numbers.** Each highlight gets a number in the left margin, in the order you make them. Numbers are never reused, so you can say "4, cut it" when you talk through the review.
- **Notes.** Tap a highlight or its number to change its tag, add a note (the microphone key on the keyboard dictates), or delete it. Right after you make a highlight, "Add note," "Record," and "Undo" appear for a few seconds.
- **Voice notes.** Tap Record in a highlight's panel (or right after making the highlight), talk, and tap Stop. The clip is saved with that highlight, where you can play it back or delete it (two taps), and its text appears under it a few seconds later. Safari asks for the microphone the first time. The number in the margin shows ✎ for a note and ♪ for a voice note.
- **List** shows every highlight with its number, text, and note. Tap one to jump to it.
- **Done** marks the item finished and returns to the queue. Open a finished item and tap Reopen to keep working on it. Reopen also brings a replaced version back to Waiting.

Everything saves as you go. If the same item is open on two devices, the changes are merged.

## Versions

Name drafts with `_v` and a number, sometimes followed by more: `Lab_grant_application_v8_review_highlighted.pdf` and `Lab_grant_application_v9.pdf` are versions 8 and 9 of one document, `Lab_grant_application`. The server takes the last `_v<number>` in the PDF's name that is followed by `_`, the extension, or nothing, as the version, and everything before it as the document. So `Lab_research_plan_v4_PREVIEW.pdf` is version 4 of `Lab_research_plan`, and `Lab_grant_cover_email_v8.pdf` is a different document from the application. A name without a version is a document of its own. `doc` and `version` in `request.json` (set with `--doc` and `--version`, or `doc=` and `version=` when sending) take the place of what the name says.

Only a higher version replaces an older one. Two items of the same document with the same version (for example, the application and a copy made for a collaborator) stay separate.

When a higher version of a document is queued, by any route, the server closes the older versions that are still waiting and have no highlights and no voice notes, within a few seconds. It never closes one you have marked; those wait for Mark older done. Closing writes `done.json` with `superseded_by` (the newer item's id), `superseded_version`, `superseded_at`, and `automatic`. Nothing else in the folder changes, and nothing is moved or deleted. The item's status becomes `superseded`, not `done`.

To undo a closing, open the item under Replaced and tap Reopen, or send `curl -X DELETE -H 'X-Review: 1' http://127.0.0.1:8765/api/items/<id>/done` on the server's machine. The server remembers what it closed (in `~/.config/review-server/replaced.json`, or `serve --state FILE`), so a reopened item stays in Waiting until a still newer version arrives. Deleting its `done.json` by hand has the same effect. `serve --no-auto-close` turns automatic closing off; Mark older done still works.

## For agents

On the server's machine, queue a PDF next to its draft:

```
python3 ~/review-server/review.py queue /absolute/path/to/drafts/file.pdf \
    --title "Project Description v24" --note "What to look at" --by "<your name or folder>"
```

This copies the PDF into `<folder>/review_queue/<YYYY-MM-DD>_<name>/`, where `<folder>` is the folder above `drafts/` (or the PDF's own folder, or `--into`), and writes `request.json`. Commit that folder with your other work. Name the PDF with its version (`..._v24.pdf`), or give `--doc NAME --version N` when the name does not say it; a newer version then replaces the older ones still waiting (see Versions). When the reviewer says they are done, read the highlights:

```
python3 ~/review-server/review.py show <item folder>          # numbered list
python3 ~/review-server/review.py show <item folder> --json   # everything
python3 ~/review-server/review.py list --root ~/projects --all
```

From any other machine on the tailnet, send a PDF and read the highlights over HTTPS (`review.py` needs only Python, so copy it if the repository is not there):

```
python3 review.py push /path/to/file.pdf --server https://<machine>.<your-tailnet>.ts.net \
    --title "Project Description v24" --note "What to look at" --by "<your name>" --group "<project folder>"
python3 review.py pull --server https://<machine>.<your-tailnet>.ts.net                     # all items
python3 review.py pull "Description v24" --server https://<machine>.<your-tailnet>.ts.net   # one item's highlights
```

Without the script, the same requests with curl (every change needs the `X-Review: 1` header):

```
curl -X POST -H 'X-Review: 1' -H 'Content-Type: application/pdf' --data-binary @file.pdf \
    'https://<machine>.<your-tailnet>.ts.net/api/queue?title=Project%20Description%20v24&filename=file.pdf&group=my_project'
curl https://<machine>.<your-tailnet>.ts.net/api/items              # all items, with ids
curl https://<machine>.<your-tailnet>.ts.net/api/items/<id>         # one item, with its highlights
```

`push` takes `--doc` and `--version` too, and the curl request takes `doc=` and `version=`.

`show` and `pull` print each highlight's notes and the text of its voice notes ("Voice note 1 (0:12, file): …"). Clips that never got attached to a highlight are listed at the end; the part of the file name before `_` is the id of the highlight it was recorded for. `list`, `pull`, and `/api/items` give each item's `doc`, `version`, and status:

- `waiting`: not reviewed yet.
- `done`: the reviewer finished it. Only this status means the highlights are final.
- `superseded`: a newer version replaced it (`superseded_by` is that item's id). The reviewer did not finish it; any highlights on it are partial. Read the newer version's review instead, and do not treat this one as done.

Then:

- Pair each thing the reviewer says with a highlight by the number they say, by the words they read aloud from it, or by order. Voice notes are the reviewer's comments on that highlight, in their words.
- "Change" highlights mark text they want changed. "Discuss" highlights mark things to raise with them; they are not edits to make on your own.
- Highlights belong to the copy in the item folder. If the draft has changed since it was queued (compare `sha256` in `request.json`), say so before applying anything.
- Do not edit `highlights.json` or `done.json`; the server writes them.

## Files in an item folder

```
<folder>/review_queue/<YYYY-MM-DD>_<name>/
    <name>.pdf        the exact copy under review
    request.json      written when queued: title, note, pdf, sha256, source, queued_by, queued_at, and group if sent
                      from elsewhere; doc and version if given
    highlights.json   written by the server: {"version", "updated_at", "max_n", "highlights": [...]}
    done.json         written when the reviewer taps Done, or when a newer version replaces the item (then with
                      superseded_by); deleted if they reopen the item
    audio/            voice notes (<highlight id>_<time>.m4a or .webm) and their text (<clip>.json)
```

Each highlight has `n` (its number), `tag` ("change" or "discuss"), `page`, `text`, `note`, `rects` (page, x, y, width, and height in PDF points from the top-left corner of the page), `audio` (its voice notes: file, seconds), and `created_at` and `updated_at`.

## Notes

- Needs Python 3.8 or later and nothing else; faster-whisper is optional, for voice-note text. PDF.js 3.11.174 (Mozilla, Apache License 2.0) is included in `static/pdfjs/`.
- Recording needs the `https://` address (browsers allow the microphone only on secure pages), which `tailscale serve` provides.
- The server reads only folders named `review_queue` under its roots. It writes `highlights.json` and `done.json` there, and new item folders only in its inbox. Its record of replaced items is in `~/.config/review-server/replaced.json`.
- Requests that change anything must carry the header `X-Review: 1`, which other websites cannot add, so a page elsewhere cannot change the queue through your browser.
- Tests: `python3 -m unittest -v test_review` in this folder (temporary folders only).
- License: MIT (see `LICENSE`); PDF.js keeps its own license in `static/pdfjs/LICENSE`.
