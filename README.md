# review-server

A review queue for PDFs and text files. Agents add a file to the queue. You open the queue on an iPad, highlight a PDF by selecting text or by drawing over it with an Apple Pencil, tag each highlight "change" or "discuss," dictate a note or record a voice note if you want one, and tap Done. Agents then read the numbered highlights and match them with what you tell them. A `.txt`, `.md`, or `.tex` file opens in an editor instead, and agents read your edits as a diff.

Each queued item is a folder of plain files. Agents on the server's machine write the folder next to the document it reviews, so git carries it with the rest of the repository. Agents elsewhere send the file to the server, which keeps it in its inbox folder.

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

The server shows items from every folder named `review_queue` under its roots (give `--root` once for each folder to search). `--inbox` adds one more root, where files sent from elsewhere go.

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

- **You, from any device:** tap Add file on the queue page and pick a PDF or a text file.
- **An agent on the server's machine:** `review.py queue` (below). The item sits next to its draft and is committed with it.
- **An agent anywhere on your tailnet:** `review.py push` (below), or the same request with curl. The item goes to the inbox at once, with no sync.

## Use it on the iPad

- **Queue.** Items waiting for you, oldest first, with the note from whoever queued them. Each document has one card, showing its newest version. Finished items are under Done; older versions that a newer one replaced are under Replaced.
- **Older versions.** If older versions of a document are still waiting, its card says so ("2 older versions"). Tap that line to list them; each still opens. **Mark older done** closes them. If any of them has your highlights or voice notes, the card lists those and asks first. Closed versions go to Replaced, labeled with the version that replaced them, not to Done.
- **Select** (the default). Touch and hold to select text, drag the handles, then tap Change or Discuss at the bottom of the screen.
- **Change pen** and **Discuss pen.** Draw over text with the Pencil. Your finger still scrolls. Without a Pencil, turn on Finger draws, and turn it off again to scroll.
- **Figure areas.** Choose Change pen or Discuss pen, then **Box**, **Blob**, or **Trace**. With Box, drag diagonally around the part of a figure you mean; with Blob, draw a loop around it. It works anywhere on a PDF, including scanned pages with no selectable text. The mark gets a number and the same Add note, Record, Undo, and tag controls as a text highlight. Tap inside it or on its number to return to the notes. Tap the chosen shape again to highlight words. Marks stay aligned when the page changes size; each saves a close-up with the exact area outlined in red for agents to inspect.
- **Tracing.** With **Trace** chosen, tap a figure or page: it opens full screen for drawing vector shapes over it, for example the outline an agent turns into a silhouette (a PhyloPic). With **Draw**, tap to place a corner point, drag as you place one to pull out a curve, and tap the first point to close the shape; **New shape** starts another, and a shape left open is a line. With **Edit**, drag points and their handles, tap a curve to add a point there, and use **Make smooth**/**Make corner**, **Delete point**, and **Close shape**. A smooth point keeps its two handles in line. The Pencil or a mouse draws; one finger moves the figure and two fingers zoom (on a laptop, scroll to move and pinch or Ctrl-scroll to zoom). **Silhouette** shows closed shapes filled black. **Undo** and **Redo** step through every change; on a keyboard, Cmd-Z, Delete, Enter (end the shape), P (Draw), and V (Edit) work too. **Done** saves the tracing as one numbered mark with a close-up; its panel has **Edit tracing** to change it later, and Undo right after puts back the version before.
- **Numbers.** Each highlight gets a number in the left margin, in the order you make them. Numbers are never reused, so you can say "4, cut it" when you talk through the review.
- **Notes.** Tap a highlight or its number to change its tag, add a note (the microphone key on the keyboard dictates), or delete it. Right after you make a highlight, "Add note," "Record," and "Undo" appear for a few seconds.
- **Voice notes.** Tap Record in a highlight's panel (or right after making the highlight), talk, and tap Stop. The clip is saved with that highlight, where you can play it back or delete it (two taps), and its text appears under it a few seconds later. Safari asks for the microphone the first time. The number in the margin shows ✎ for a note and ♪ for a voice note.
- **List** shows every highlight with its number, text, and note. Tap one to jump to it.
- **Sections.** Each time you open the app, only **Waiting** is open; Done, Replaced, Archived, and Trash start closed, so the queue is never scrolled past by accident.
- **Swipe a card left** for **Archive** and **Trash**, as in Mail; swipe all the way to archive it, and **Undo** appears for a few seconds. On a Mac, swipe with two fingers on the trackpad, or drag with the mouse. Archiving a card archives its older waiting versions with it. Neither deletes anything: archived and trashed items keep all their files and marks, wait under **Archived** and **Trash** at the bottom of the queue, and a swipe there restores them to where they were. `show` and `pull` say when an item was archived or trashed.
- **Done** marks the item finished and returns to the queue. Open a finished item and tap Reopen to keep working on it. Reopen also brings a replaced version back to Waiting.

Everything saves as you go. If the same item is open on two devices, the changes are merged.

The **Theme** button at the top of every page switches between following the device, dark, and light. Each device remembers its choice.

## Edit a text file

A `.txt`, `.md`, `.markdown`, or `.tex` file (UTF-8, up to 5 MB) opens in an editor: one centered column of text, wrapped on screen. Wrapping never adds line breaks to the file. The toolbar slides away while you type and comes back when you move the pointer or touch the screen.

- **Vim keys.** Tick the box for vim keys; each device remembers it. Insert, visual, `/` search, `u`, and the rest work, `:w` saves at once, and `:q` or `:wq` goes back to the queue. `j`, `k`, `$`, `0`, and `^` move by the lines on screen, as `gj`, `gk`, `g$`, `g0`, and `g^` do (`dj`, `d$`, and `D` still mean whole lines, and `A` and `I` go to the ends of the whole line), and holding a movement key repeats it even where the device sends no key repeats. Searches and `:s` use Vim's own patterns and are case-sensitive unless you `:set ic`. `"+y` copies to the system clipboard. `gq` and `gw` rewrap to `textwidth`, or 79 columns. `:s` handles any delimiter, `\\` as a backslash, and the `n` flag, and Ctrl-R pastes a register into the `:` and `/` prompts. Macros and `:normal` stop at the first failed move, and macros can run `:` commands. About 96% of a large set of key sequences match real Vim exactly (`tools/vim-compare/`). The main gaps: search offsets such as `/word/e`, text objects started on a blank line, some block-mode corners, `|` between `:` commands, addresses such as `:/foo/d`, and `qA` to add to a macro. `:set` lasts until the page reloads; there is no vimrc. On a keyboard without an Esc key, use Ctrl-[. Without vim keys it is an ordinary text box, where Cmd-S or Ctrl-S saves at once.
- **Highlighting.** Markdown and LaTeX get quiet syntax colors. Words you have changed have a soft green tint, and a small tick marks where you removed text.
- **Text size.** **A−** and **A+** make the text smaller or larger, with or without vim keys, and each device remembers it. The column stays about the same number of characters wide.
- **Your place.** Each browser remembers the cursor and scroll position for each text file, and goes back there when you reopen or reload it.
- **Preview.** For Markdown, the Preview button shows the rendered text beside the editor, updated whenever typing pauses, with your changes in green there too. The two sides scroll together, whichever one you scroll. Figures in raw LaTeX blocks and their captions are shown; other LaTeX layout commands are left out, so this is a reading view, not the final PDF. Raw HTML in a file is shown as text and never run. LaTeX files have no preview.
- **Saving.** Edits save as you type. The file as queued never changes; your version goes to `edited/<name>` in the item folder. **Revert** goes back to the file as queued, and Undo brings your edits back.
- **Two devices.** If the file changed on another device since this page loaded it, the page stops saving and asks whether to keep your version or use the other.
- **Done** saves first, then marks the item finished. A finished or replaced item is read-only until you tap Reopen.
- **Images.** Each image the text refers to (`![](...)` or `<img>` in Markdown, and `\includegraphics` in LaTeX or in raw LaTeX inside Markdown, including PDF figures and `\graphicspath`) shows under the line that refers to it. **Images** lists them in the order of the text; tap one to jump to it. Tap an image to open it by itself. `review.py queue` and `push` bring along any image in the file's folder or git repository, and nothing from outside it. They look where the reference says, then for the one file with that name under a `figures`, `figs`, or `images` folder beside the text file or one folder up. An image that did not come along shows an **Add image** button.

The iPad keyboard's dictation works as in any text box.

**Highlights and voice notes.** Besides editing, you can mark up a text file as you would a PDF. Choose **Change pen** or **Discuss pen**, then draw across words with an Apple Pencil (or a mouse): the whole words it crosses are highlighted, and nothing is written by hand. Fingers still scroll. Right after a highlight, tap **Record** to leave a voice note; later, tap its number in the margin, or the highlight itself while a pen is chosen, to open its panel. **List** shows them all. With **Edit** chosen, select text with a finger, a mouse, or visual mode and tap Change or Discuss. While a pen is chosen the editor takes no typing, so the keyboard stays away. On a touch screen a file opens with a pen chosen, and each device remembers your choice.

Highlights move with the text as you edit it. If you delete all of a highlight's words it stays in the list, with its voice notes, marked as gone. If the text is replaced (Revert, or using another device's version), each highlight finds its words again nearby, if they are still there. In a Markdown file's Preview you can do the same: draw across the rendered words, tap a highlight to open it, or with **Edit** chosen select text and tap Change or Discuss. The highlight lands on those words in the source, on both sides.

**Figures in text files.** With either pen chosen, drag across an image to box an area of it (or choose Blob or Trace, as on a PDF); this works both in the editor and in Markdown Preview, including the first page of an embedded PDF figure. The box is attached to that image reference, so adding or removing paragraphs above it does not move the mark. The same image shown in both panes shows the same boxes. Choose Edit to open an image by itself as before. A figure removed from the text keeps its marks, notes, and saved close-ups in List. Images loaded from another website may prevent a close-up from being saved; in that case the box location is still kept and the page tells you.

## Versions

Name drafts with `_v` and a number, sometimes followed by more: `Lab_grant_application_v8_review_highlighted.pdf` and `Lab_grant_application_v9.pdf` are versions 8 and 9 of one document, `Lab_grant_application`. The server takes the last `_v<number>` in the PDF's name that is followed by `_`, the extension, or nothing, as the version, and everything before it as the document. So `Lab_research_plan_v4_PREVIEW.pdf` is version 4 of `Lab_research_plan`, and `Lab_grant_cover_email_v8.pdf` is a different document from the application. A name without a version is a document of its own. `doc` and `version` in `request.json` (set with `--doc` and `--version`, or `doc=` and `version=` when sending) take the place of what the name says.

Only a higher version replaces an older one. Two items of the same document with the same version (for example, the application and a copy made for a collaborator) stay separate.

When a higher version of a document is queued, by any route, the server closes the older versions that are still waiting and have no highlights, voice notes, or edits, within a few seconds. It never closes one you have marked or edited; those wait for Mark older done. The extension does not matter, so `Plan_v2.tex` replaces `Plan_v1.pdf`. Closing writes `done.json` with `superseded_by` (the newer item's id), `superseded_version`, `superseded_at`, and `automatic`. Nothing else in the folder changes, and nothing is moved or deleted. The item's status becomes `superseded`, not `done`.

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
- A **figure area** points to visual content, not surrounding text. `show` and `pull` give the PDF page or the exact image reference, the box position, and the saved close-up's local path or server URL. Open that image and read its notes/transcript together before modifying the figure. Coordinates are fractions of the complete page or image from the top-left, displayed as percentages in the report. The red outline in the close-up marks the exact selected area; a small margin supplies context. The close-up records what was visible when marked, so check the source if the image has since changed. If no close-up is available, inspect the box in the original page or image.
- Highlights belong to the copy in the item folder. If the draft has changed since it was queued (compare `sha256` in `request.json`), say so before applying anything. On a text file they follow the reviewer's edits: their line numbers are in `edited/<name>` if it exists, and `show` and `pull` print the highlights first and then the diff.
- Do not edit `highlights.json` or `done.json`; the server writes them.

For a text file, queue or push it the same way. `show` and `pull` print a diff of the reviewer's edits, or say there were none. `show --json` and `/api/items/<id>` give `text.original`, `text.current`, `text.diff`, and `text.edited`; the edited file is also at `edited/<name>` in the item folder. Apply the edits from `current`, and do not write to `edited/` yourself. As with PDFs, only `done` means the reviewer finished.

Without the script, send an image a text file refers to with `curl -X POST -H 'X-Review: 1' --data-binary @fig.png '<server>/api/items/<id>/images?ref=<the path as written in the text>&filename=fig.png'`.

## Files in an item folder

```
<folder>/review_queue/<YYYY-MM-DD>_<name>/
    <name>.pdf        the exact copy under review (or <name>.md, .tex, or .txt for a text file)
    request.json      written when queued: title, note, pdf or text, sha256, source, queued_by, queued_at, and group if
                      sent from elsewhere; doc and version if given; images, a map from each reference in the text to its file
    highlights.json   written by the server: {"version", "updated_at", "max_n", "highlights": [...]}
    done.json         written when the reviewer taps Done, or when a newer version replaces the item (then with
                      superseded_by); deleted if they reopen the item
    audio/            voice notes (<highlight id>_<time>.m4a or .webm) and their text (<clip>.json)
    edited/<name>     a text file with the reviewer's edits; gone again if they undo every edit
    images/           the images a text file refers to
    regions/          PNG close-ups for figure marks (<highlight id>.png), with the selected area outlined
```

Each highlight has `n` (its number), `tag` ("change" or "discuss"), `page`, `text`, `note`, `rects` (page, x, y, width, and height in PDF points from the top-left corner of the page), `audio` (its voice notes: file, seconds), and `created_at` and `updated_at`.

A figure mark also has `region`: `{x, y, w, h, page}` for a PDF, or `{x, y, w, h, image}` for an image reference in a text file. These coordinates are fractions from 0 to 1, independent of screen size; `text` and `rects` are empty, and there is no text `anchor`. When a close-up was saved, `region.snapshot` is its filename under `regions/`, also available from `/api/items/<id>/regions/<filename>`. Crops are saved with the highlights in the same version-checked request. Deleting and undoing a mark preserves its crop.

A blob also has `shape: "blob"` and `points`, its outline as `[x, y]` fractions. A tracing has `shape: "vector"`, `size` (the width and height of the image in pixels, or of the PDF page in points), and `paths`: each `{closed, nodes}`, where a node is `[x, y, in x, in y, out x, out y]`, the point and its two bezier handles, all fractions of the image (handles may reach a little past its edge). A segment runs from one node's out handle to the next node's in handle; a closed shape also joins the last node to the first. For both, `x, y, w, h` is the box around the shape. The server also writes each tracing as `regions/<highlight id>.svg`, at the image's own size, with closed shapes filled black and open ones as lines, ready to become a silhouette.

To check the server, run `python3 -m unittest -q test_review`. Figure interaction checks use a temporary server and headless Chrome: `node tools/test-regions.mjs` (Node 22+ and Chrome, no npm packages). `CHROME` and `PYTHON` can select the executables. These checks use temporary documents and leave the real queue alone.

## Feedback, and the app's agent

The queue has a **Feedback** button. Write there what you would like changed or fixed in the app itself, from any device. One agent on the server reads it, makes the change in its own copy of the app, tests it, and answers in the same place. It can ask a question with buttons to tap; a banner on the queue says when it is waiting for you, and the button shows a count of new messages. Nothing it changes goes live until you tap **Put it live** on its message; then the server is restarted once nobody has saved anything for a minute, and the agent says when it is done. The panel also says whether the agent is there and what it is doing.

To run the agent (on the machine with the server, with Claude Code installed and signed in):

```
python3 tools/feedback_agent.py --work /path/for/the/agent --live /path/to/this/checkout --service review-server
```

It keeps its own clone of the repository, its notes, and a log of each piece of work under `--work`. Claude Code works only in that clone, with a short list of tools (reading and editing files, git, python3, node), and never pushes, deploys, or restarts anything: the script does those, and only for a commit the reviewer chose to put live. Before that it runs the unit tests on exactly that commit, and refuses a commit older than what is live. With `--push-key` (an SSH deploy key that may write to the repository) and `--push-url`, it pushes the commit to GitHub first, so every copy stays the same; without one it says GitHub was not updated. `--path` puts folders first on Claude's PATH, for example a newer Node for `tools/test-regions.mjs`. Its standing instructions are `tools/feedback-agent.md`. As a systemd user service:

```
[Unit]
Description=The agent that looks after the review queue
After=review-server.service

[Service]
ExecStart=/usr/bin/python3 /path/to/this/checkout/tools/feedback_agent.py --work /path/for/the/agent --live /path/to/this/checkout --service review-server
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
```

Messages are kept in `feedback.json` beside the server's other state (`~/.config/review-server/` unless `--state` says otherwise). Only a program holding `agent-token` from that folder, which the server makes on first start, can write as the agent; agents reply with `python3 review.py feedback say "..." [--choice ...] [--deploy <commit>]`, read with `review.py feedback list`, and say what they are doing with `review.py feedback status working --note "..."`. Each message you send starts a piece of work by Claude Code on the server's account. Check the agent end to end, with a stand-in for Claude, with `python3 -m unittest -q tools.test_feedback_agent`.

## Notes

- Needs Python 3.8 or later and nothing else; faster-whisper is optional, for voice-note text. PDF.js 3.11.174 (Mozilla, Apache License 2.0) is included in `static/pdfjs/`, and CodeMirror 5.65.21 (MIT License) in `static/codemirror/`.
- Recording needs the `https://` address (browsers allow the microphone only on secure pages), which `tailscale serve` provides.
- The server reads only folders named `review_queue` under its roots. It writes `highlights.json` and `done.json` there, and new item folders only in its inbox. Its record of replaced items is in `~/.config/review-server/replaced.json`.
- Requests that change anything must carry the header `X-Review: 1`, which other websites cannot add, so a page elsewhere cannot change the queue through your browser.
- Tests: `python3 -m unittest -v test_review` in this folder (temporary folders only).
- `/keytest` is a page with the real editor and vim keys that records the keys pressed on that page and the cursor's movements, and saves them to `~/.config/review-server/keylogs/`, to see what a real keyboard and browser do. marked 12.0.2 (MIT License), which renders the preview, is included in `static/marked/`.
- CodeMirror's vim keymap is patched in `static/codemirror/keymap/vim.js` (search for `review-server:`), with additions in `static/vim-fixes.js`. When either changes, raise `CM_VERSION` in `static/app.js`, because the library files are cached for a day.
- License: MIT (see `LICENSE`); PDF.js and CodeMirror keep their own licenses in `static/pdfjs/LICENSE` and `static/codemirror/LICENSE`.
