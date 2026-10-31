# Compare the editor's vim keys with real Vim

Runs about 7,400 keystroke sequences through real Vim and through the editor in headless Chrome, then compares the resulting text and cursor. This needs Vim, Chrome, and Node, none of which the server itself uses.

```
cd tools/vim-compare
npm install --no-save puppeteer-core
python3 cases.py && python3 run_vim.py       # cases.json, and Vim's results in vim.json

printf 'Plain text.\n' > Plain.txt          # the editor needs one text item to type in
python3 ../../review.py queue Plain.txt --title Plain --into /tmp/vimq
python3 ../../review.py serve --root /tmp/vimq --port 18810 --state /tmp/vimq/replaced.json &
node compare.mjs 18810 cm.json               # CHROME=/path/to/chrome if it is elsewhere
python3 analyze.py cm.json
```

`analyze.py` prints how many sequences differ, grouped by command. It leaves out commands that depend on the size of the window. Vim merges undo steps when it reads keys from a script, so sequences with several undoable commands before a `u` are left out too.

`cases_editing.py` has about 230 more, for substitutes, macros, `gq`, `:normal`, marks, undo steps, and emoji. They run through Vim in a terminal, so keys count as typed and undo steps are real:

```
python3 cases_editing.py && python3 run_vim_pty.py
node compare.mjs 18810 cm.json
python3 differences.py
```
