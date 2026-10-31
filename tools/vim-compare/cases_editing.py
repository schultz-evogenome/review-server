# Editing cases that need undo steps as typed: substitutes, macros, gq, :normal, marks, emoji. Run with run_vim_pty.py.
import json
F = '''The \\alpha and \\beta terms a/b
path/to/file and C:\\temp
% comment line that is long and needs to wrap with gq
- item one is here and it goes on for a while longer
- item two is here

  two  spaces  inside this line
caf\u00e9 na\u00efve r\u00e9sum\u00e9 cafe
a\U0001F600b\U0001F600c
one
two
three
four
'''
cases = r'''
:%s/a/X/gn<CR> :s/a/X/n<CR>
:s/The/\\t/<CR> :s/The/a\\b/<CR> :s/The/\&/<CR> :s/The/&\0/<CR> :s/The/\t/<CR> :s/The/$1/<CR> :s/The/$&/<CR> :s/\(The\)/\1\1/<CR> :s/The/\r/<CR> :s/The/\x/<CR> :s/The/x\/y/<CR> :s/The/\\alpha/<CR> :s/\\alpha/\\gamma/<CR> :s/\\alpha/\\\\/<CR> :s/\v(The)<Space>(.)/\2\1/<CR>
:s#a/b#X#<CR> :s/a\/b/X/<CR> :s/a\/b/c\/d/<CR> :s#a/b#c/d#<CR> :s,a/b,X\,Y,<CR> :2s#path/to#X#<CR> :2s/path\/to/X/<CR> :2s#/#\##g<CR> :2s#\/#Y#g<CR>
:%s/\S\+/X/<CR> :%s/\S*/X/<CR> :%s/\A\+/X/g<CR> :%s/\D\+/X/<CR> :%s/\L\+/X/<CR> :%s/\U\+/X/<CR> :%s/\H\+/X/<CR> :%s/\X\+/X/<CR> :%s/\O\+/X/<CR> :%s/\W\+/X/<CR> :%s/\I\+/X/<CR> :%s/\K\+/X/<CR> /\A\+<CR>x 5G/\S\+<CR>x
yiw:s/<C-r>"/X/<CR> "ayiw:s/<C-r>a/Y/<CR> w/<C-r><C-w><CR>x yiwj/<C-r>0<CR>x
qajxq99@a Gqakxq99@a qafzxq 10Gqalxq9@a 10G$qahxq9@a 10Gqa0fzjxq3@a qafzxjq3@a qa0xjq99@a :%normal<Space>fax<CR> :s/a/X/<CR>u :2,4normal<Space>fzx<CR> :1,3normal<Space>0fax<CR> 10Gqajq@a@a@ax
3Ggqq 3GVgq 4Ggqj 4GVjgq ggVGgq :set<Space>tw=30<CR>3Ggqq :set<Space>tw=30<CR>4Ggqj :set<Space>tw=30<CR>ggVGgq :set<Space>tw=30<CR>8Ggqq :set<Space>tw=30<CR>7Ggqq 7Ggww :set<Space>tw=10<CR>ggVGgq
R12<BS><BS><Esc> R12<Esc>jR3<BS><BS><Esc> R12<Esc>jR3<BS><BS>x<Esc>
:99d<CR> :2,99d<CR> :99y<CR>P :99m0<CR> :1m99<CR> :1-5d<CR> :99t0<CR> :99j<CR> :99><CR> :99normal<Space>x<CR> :99put<CR>
3Gmagg3Gddgg'ax 3GmaggGdd'ax 3Gmaggdd`ax 3Gma4Gddgg'ax 3Gma:3d<CR>gg'ax 3Gmb2Gmagg:2,3d<CR>'bx
yyjVpGp yyjVPGp yiwjVpGp yiwwviwPwviwP yyjvePGp yyjVp"0p yiwjVPGp
ixy<Esc>j. Aab<C-o>0cd<Esc>j. Aab<Esc>jAcd<Esc>j. qaAxy<Esc>q@a
Aabc<C-o>0X<Esc> 2G5li<C-o>lX<Esc> 2G5liQ<C-o>hX<Esc> 2G5li<C-o>~X<Esc> 2G5li<C-o>xX<Esc>
9GlrX 9Gl2rX 9Gl9rX 9G3rX 9Gx 9Glx 9Glyl$p 9G$hx 9Gllx 9Glllx 9Gl~ 9Gl. 9Glylp 9G$x 9Glvd 9Glvy$p 9Gla!<Esc> 9Gl2a!<Esc> 9Gv$d 9Gvlld 9G$vhd 9Glcl!<Esc> 9Glsx<Esc> 9GlP 10Gl9rX 6GrX
6GJ 6G2J 5GJ 6GJJ 5G3J 4GJJ 7GJ
:2d<CR>P :2,3d<CR>P :2y<CR>Gp :2,3y<CR>P :2d<Space>a<CR>"aP :2d<CR>"1P
:2ma<Space>a<CR>gg'ax :3k<Space>a<CR>gg'ax :2mark<Space>b<CR>gg'bx
7GAtrail<Space><Space><Esc> 7G$a<Space><Space><Esc> 7GA<Esc> 7Go<Esc> 7GA<CR><Esc> 7GI<Space><Space><Esc> o<Space><Space>x<Esc> 7Gcc<Esc> A<CR><Space><Space><Esc> 7GO<Esc> 6Gi<Space><Space><Esc> 6GiX<BS><Esc> 7G$aX<BS><Esc> 7Ga<Space><BS><Esc> 7GcwX<BS><Esc> 7Go<Space><Esc> 7GoX<BS><Esc>
<C-v>jlX <C-v>jlD 2G5l<C-v>jlX 2G5l<C-v>jlXu
:2,4normal<Space>Ax<CR> :%normal<Space>dd<CR> :1,3normal<Space>ox<CR> :%normal<Space>Ax<CR> :1,3normal<Space>dd<CR> :1,4normal<Space>J<CR> 3G:normal<Space>x<CR>
qa:s/a/X/<CR>q@a qa:s/a/X/<CR>jq2@a qa:%s/e/E/g<CR>qu@a qa:2d<CR>q@a qa:s/a/X/<CR>/one<CR>q@a qa/two<CR>:s/o/Q/<CR>q@a
qafqxq@a qa"qyyq@a qamqjq@ax qa'qq qarqq@a qaFqxq
/\<r.sum<CR>x /\<caf<CR>nx /\<na.ve\><CR>x :9s/\<caf\>/X/<CR> :8s/\<caf\>/X/<CR> :8s/\<caf.\>/X/g<CR> :8s/\k\+/X/g<CR> :8s/\i\+/X/g<CR> /\<sum<CR>x
Vj:m'>+1<CR> 2GVj:m'<-2<CR> 2GVj:m'>+1<CR>u
:s/a//<CR> :s/a/X/<CR>:s/e//<CR> :s/The<CR> :s/a/X/<CR>:s/e/~Y/<CR> :s/the/X/i<CR> :s/The/X<CR>
Aab<BS>c<Esc>u iab<Left>c<Esc>u iab<Left>c<Esc>uu iab<Left>c<Esc>uu<C-r> Aab<Up>cd<Esc>u Aab<Up>cd<Esc>uu<C-r><C-r> oab<Left>c<Esc>uu Aab<CR>cd<Esc>u Aab<Esc>u<C-r> Aab<Esc>Acd<Esc>uu Aab<Esc>Acd<Esc>uu<C-r> Aab<Esc>Acd<Esc>uu<C-r><C-r> Aab<Esc>Acd<Esc>u oab<BS>cd<Esc>u ccab<BS>c<Esc>u ccab<Esc>u<C-r>u cwab<Esc>u<C-r> 3iab<Esc>u 3oab<Esc>u oab<CR>cd<CR>ef<Esc>u oab<CR>cd<Esc>uu<C-r> oab<CR>cd<Esc>u<C-r>u xAab<Esc>uu xAab<Esc>uu<C-r> ddoab<Esc>uu ciwab<BS><BS>cd<Esc>u
'''
out = []
for c in cases.split():
    if c not in out:
        out.append(c)
json.dump({'text': F, 'cases': [['editing', c] for c in out]}, open('cases.json', 'w'))
print(len(out), 'cases')
