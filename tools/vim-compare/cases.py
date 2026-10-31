import json, itertools
F = '''alpha beta gamma
  indented line here
foo(bar, baz) { qux }
"quoted text" and 'single'

last_word second-word third.word
The quick brown fox. Another sentence here. And one more!
[one [two] three] <tag>x</tag>

fifth paragraph line one
fifth paragraph line two
1 apples 20 pears -3 plums 0x0f
'''
starts = ['gg', '2G5l', '3G8l', '3G14l', '4G3l', '6G10l', '7G25l', '8G6l', '5G', '12G']
motions = ['h','l','j','k','w','W','b','B','e','E','ge','gE','0','^','$','g_','+','-','<CR>','{','}','(',')','%','fa','Fa','ta','Ta','fa;','fa,','tp;','G','gg','3G','|','5|','*','#','*n','#N','g*','[(','])','[{',']}','<Space>','<BS>','3w','2e','2j','2k','5l','9j','9k','3b','2$','d','/fox<CR>','?line<CR>','/line<CR>n','ma0`a',"ma0'a",'mak``']
ops = [('', ''), ('d', ''), ('y', 'P'), ('c', 'X<Esc>'), ('gU', ''), ('g~', ''), ('>', '')]
tobj = ['iw','aw','iW','aW','i(','a(','ib','ab','i{','a{','iB','aB','i[','a[','i<lt>','a<lt>','i"','a"',"i'","a'",'is','as','ip','ap','it','at','2iw','2aw']
cases = []
for s in starts:
    for m in motions:
        if m == 'd': continue
        for op, tail in ops:
            cases.append(['motion', s + op + m + tail])
    for t in tobj:
        for op, tail in ops[1:]:
            cases.append(['textobj', s + op + t + tail])
        cases.append(['visual-obj', s + 'v' + t + 'd'])
        cases.append(['visual-obj', s + 'v' + t + 'U'])
act = r'''x X 3x 3X dd 2dd 9dd yyp yyP Yp 2yyp ddp ddP D C<Esc> CX<Esc> SX<Esc> sX<Esc> 3sX<Esc> cwX<Esc> cWX<Esc> cbX<Esc> ccX<Esc> 2ccX<Esc> rX 3rX 9rX r<CR> R1234<Esc> R12<BS><BS><Esc> iX<Esc> aX<Esc> IX<Esc> AX<Esc> oX<Esc> OX<Esc> 3iX<Esc> 3aX<Esc> 3oX<Esc> 3OX<Esc> 3IX<Esc> 3AX<Esc> gIX<Esc> iab<Esc>jgiX<Esc> J 3J 9J gJ 3gJ ~ 3~ 9~ g~~ gUU guu g?? g?w >> << 3>> 2<lt><lt> == u <C-r> xu xxuu xxuu<C-r> ddu ddu<C-r> dwdwu.  xU iab<Esc>U dw. dd. x. 3x. cwX<Esc>w. iX<Esc>j. AX<Esc>j. oX<Esc>j. rXl. ~. >>. 2dd. dw2. ciwX<Esc>w. A!<Esc>j.
<C-a> <C-x> 5<C-a> 5<C-x> 12G<C-a> 12G5w<C-a> 12G$<C-a> 12G9w<C-x> 12G<C-a>. p P yiwP yiwp ywP ywp yiwwP yiwwp yyjp yyjP ddjp 3yyGp ywgP ywgp yygp yygP yy]p "ayyj"ap "ayiwj"aP "ayy"Ayyj"ap "_ddP ddj"1P dwdd"-p yiwddP"0p "ayyu"ap qaxq@a qaxjq@a@@ qaxjq2@a qaAX<Esc>jq@a qqddq@q qa0wxq:normal<Space>@a<CR> ma2jd`a ma2jd'a majy`aP ma2jy'aP mAj`A `[ yy`[ iab<Esc>`] 2Gi<Esc>`^ jg; xjjg; xjjxg;g;
<C-o> jj<C-o> jjgg<C-o> jjgg<C-o><C-i> gg'' 3G`` Gg, ga g8 gi gv vjy<Esc>gg gvd vjd vj<Esc>ggjgvd v$d vjj$d vly vlyP vlyp vld vlD vlY vlC<Esc> vlcX<Esc> vlsX<Esc> vlSX<Esc> vlRX<Esc> vlxP vlX vlrX vl~ vlU vlu vlJ vjJ vjgJ vj> vj<lt> vj= vjoj vjokd vlohd vlOhd vlgvd vwwd veed vbd vGd vggd v%d v/line<CR>d vfad vtad V V> V<lt> Vd Vy Vyp VyP Vjd Vjy Vjyp VjJ VjgJ VU Vu V~ VrX VcX<Esc> VsX<Esc> VSX<Esc> VRX<Esc> VCX<Esc> VDp VXp VYp Vjo Vjod V2jd V3> VGd Vggd Vip Vipd Vapd vipd vapd viwp yiwwviwp yyjVp yiwjVp yyjvep yiwwviwpp vjvd vVd Vvd
<C-v>jd <C-v>jjd <C-v>jly <C-v>jlyP <C-v>jlyp <C-v>jlx <C-v>jlX <C-v>jlD <C-v>jlY <C-v>jlC<Esc> <C-v>jlCX<Esc> <C-v>jlcX<Esc> <C-v>jlsX<Esc> <C-v>jlSX<Esc> <C-v>jlrX <C-v>jlIX<Esc> <C-v>jlAX<Esc> <C-v>j$AX<Esc> <C-v>j$d <C-v>j$y <C-v>j$yP <C-v>j~ <C-v>jlU <C-v>jlu <C-v>j> <C-v>j<lt> <C-v>jJ <C-v>jlod <C-v>jlOd <C-v>jloOd <C-v>jlgvd <C-v>jl<Esc>gvd <C-v>2j2ld <C-v>Gd <C-v>Gyp <C-v>jlv <C-v>jlV <C-v>jl<C-v> gg<C-v>jjIX<Esc>j. 
guiw gUiw g~iw gUU g~~ gu$ gU$ g~$ gq gqq gqip gqap gww gwip gJ gi 3gi gk gj g0 g^ g$ gm gM g_ gn gN /line<CR>gnd /line<CR>cgnX<Esc> /line<CR>cgnX<Esc>. dgn /line<CR>dgn /line<CR>dgn. /line<CR>gnyP ZZ<Esc> zz zt zb z. z- z<CR> gg= =G =ip >ip <lt>ip >G gg>G >}  dG dgg d} d{ d) d( d% c}X<Esc> y}P y}p
<C-w> ciwX<C-w>Y<Esc> ix<C-w><Esc> A<Space>abc<C-w><Esc> Aabc<C-u>X<Esc> Aabc<C-h><Esc> A<BS><Esc> A<BS><BS>X<Esc> i<BS>X<Esc> ji<BS>X<Esc> yiwA<C-r>0<Esc> yiwA<C-r>"<Esc> A<C-o>0X<Esc> A<C-o>dbX<Esc> i<C-o>$X<Esc> A<C-t><Esc> A<C-d><Esc> 2GA<C-d><Esc> A<C-t><C-d><Esc> A<Tab>X<Esc> i<Tab><Esc> A<CR>X<Esc> i<CR><Esc> 2GA<CR>X<Esc> 2GA<CR><Esc> 2GoX<Esc> 2GOX<Esc> 2Go<Esc> o<Esc> O<Esc> Oa<Esc>u 3Gi<C-v>u0041<Esc> i<C-e><Esc> ji<C-y><Esc> i<C-k>e:<Esc> Aabc<Esc>. Aabc<Esc>u iabc<Esc>u<C-r> Aab<Esc>ucd<Esc> ixy<Left>z<Esc> ixy<Right>z<Esc> Axy<Up>z<Esc> jAxy<Up>z<Esc> AX<Down>Y<Esc>u
:2<CR> :$<CR> :2d<CR> :2,3d<CR> :%d<CR> :.d<CR> :$d<CR> :.,+1d<CR> :2y<CR>P :2,3y<CR>p :1m3<CR> :3m0<CR> :1t3<CR> :1co3<CR> :1copy3<CR> :2,3m$<CR> :1j<CR> :1,3j<CR> :1>><CR> :2<lt><CR> :1,2><CR> :s/alpha/X/<CR> :s/a/X/g<CR> :%s/line/X/<CR> :%s/line/X/g<CR> :%s/e/E/g<CR>u :1,3s/a/X/g<CR> :s/\(alpha\)/[\1]/<CR> :s/a\+/X/<CR> :s/\<beta\>/X/<CR> :s/al.*a/X/<CR> :s/^/X/<CR> :s/$/X/<CR> :%s/^/X/<CR> :s/alpha/&&/<CR> :s/alpha\|beta/X/g<CR> :s/\v(alpha)\s/[\1]/<CR> :%s/line/X/<CR>& :s/a/X/<CR>:s<CR> :s/a/X/<CR>& :s/a/X/<CR>g& :s/a/X/<CR>j:&&<CR> :%s/\s\+$//e<CR> :s/\u/X/<CR> :s/\d/X/<CR> :12s/\d\+/N/g<CR> :s/a/\r/<CR> :s/ /\t/<CR> :s/\w\+/\U&/<CR> :s/\w\+/\u&/<CR> :g/line/d<CR> :g/line/s/line/X/<CR> :v/line/d<CR> :g!/line/d<CR> :g/line/normal<Space>Ax<CR> :g/^$/d<CR> :sort<CR> :1,3sort<CR> :sort!<CR> :%sort<Space>i<CR> :%normal<Space>Ax<CR> :normal<Space>dw<CR> :2,3normal<Space>x<CR> :noh<CR> :undo<CR> xx:undo<CR> xxu:redo<CR> :k<Space>a<CR> :mark<Space>a<CR>2G`a :delm<Space>a<CR> :reg<CR> :registers<CR> :marks<CR> :e!<CR> xx:e!<CR> :set<Space>sw=4<CR>>> :set<Space>ts=8<CR> :set<Space>ic<CR>/ALPHA<CR>x :set<Space>noic<CR> :set<Space>ai<CR> :set<Space>tw=20<CR> :set<Space>nu<CR> :set<Space>wrap<CR> :let<Space>a=1<CR> :put<CR> yy:put<CR> yy:put!<CR> yy:3put<CR> :1,2w!<Space>/dev/null<CR> :ve<CR> :h<CR> :nohlsearch<CR> :map<CR> :nmap<Space>,x<Space>dd<CR>,x :imap<Space>jk<Space><lt>Esc><CR>iajk :vmap<Space>,x<Space>d<CR>vl,x :unmap<Space>,x<CR> :cmap<Space>ab<Space>cd<CR> :1,2ya<CR>P :1,2>><CR>:2,3<lt><lt><CR> :d<Space>2<CR> :2d<Space>a<CR>"aP :1,3g/a/d<CR> :1pu<CR> :2i<CR>x<CR>.<CR> :2a<CR>x<CR>.<CR>
/beta<CR>x /a\+<CR>x /\<beta\><CR>x /al.*a<CR>x /(bar<CR>x /foo(<CR>x /\(bar\)<CR>x /bar\|baz<CR>x /\vbar|baz<CR>x /\d\+<CR>x /[0-9]\+<CR>x /x$<CR>x /^T<CR>x /fox.<CR>x /FOX<CR>x /\cFOX<CR>x /line<CR>nx /line<CR>nnx /line<CR>Nx ?line<CR>x ?line<CR>nx ?line<CR>Nx /line/e<CR>x /line/+1<CR>x /line/-1<CR>x /line/s+1<CR>x /line/b+1<CR>x /line/e-1<CR>x //<CR>x /line<CR>//<CR>x ?line<CR>??<CR>x *x #x *nx **x g*x g#x *Nx *``x 2*x 2nx /line<CR>2nx d/line<CR> c/line<CR>X<Esc> y/line<CR>P d/line/e<CR> /nomatch<CR>x dn dN d/nomatch<CR> /alpha<CR>x /gamma<CR>x /\s\+<CR>x /\w\+<CR>x /\.<CR>x /.<CR>x /\$<CR>x /$<CR>x /a*<CR>x /{<CR>x /\{<CR>x /a\{1}<CR>x /(<CR>x /)<CR>x /[<CR>x /\[<CR>x /+<CR>x /?<CR>x /|<CR>x
fa; fa;; 2fa fa2; ta; ta;; ta, Fa, 3fe ;  , te; tp;; dfa dta dFa dTa cfaX<Esc> ctaX<Esc> yfaP ytaP d2fa dfa. dta. d2ta 2dfa vfad vtad vfa;d vfa,d
3l 3h 99l 99h 99j 99k 3| 99| 3w3b 3e 3ge 99w 99b 99e 99ge 3$ 99$ 2G0 2G^ 2G$ 2Gg_ 2G+ 2G- 4+ 4- 4<CR> 3G% 3G$% 8G% 8G$% 3Gf(% 3Gf{% 8Gf[% 7G) 7G)) 7G( 7G$( 7G$(( 6G} 6G{ }} {{ }}{ 3} 3{ 3) 3( 99} 99{ 99) 99( G{ G} G) G( G$( [[ ]] [] ][ [m ]m [M ]M [# ]# [* ]* [/ ]/ ]) [( ]} [{ gg]} H M L <C-d> <C-u> <C-f> <C-b> <C-e> <C-y> 2<C-d> 3<C-e>
'''
for c in act.split():
    cases.append(['action', c])

ctrl = 'abcdefghijklmnopqrstuvwxyz'
for c in ctrl:
    cases.append(['ctrl-normal', '2G5l<C-%s>' % c])
    cases.append(['ctrl-normal', '2G5l<C-%s>x' % c])
    cases.append(['ctrl-insert', '2G5liQ<C-%s>Z<Esc>' % c])
for c in ['5Gdiw','5Gdaw','5GciwX<Esc>','12Gdj','ggdk','Gdj','G+','Gd+','ggd-','jjdd','Gdd','ggVGd','Gp','yyGp','G$x','Goend<Esc>','GA!<Esc>','GJ','G3J','}}}}}}','G}','G{d}','*','gg*','G#','3G5l*d*','3G5ld*','2G5ld#']:
    cases.append(['more', c])
for c in ['cwX<Esc>u','ccX<Esc>u','sX<Esc>u','SX<Esc>u','CX<Esc>u','oX<Esc>u','OX<Esc>u','ciwX<Esc>u','RX<Esc>u','AX<Esc>u','iX<Esc>u','cwX<Esc>u<C-r>','oX<Esc>u<C-r>','ccX<Esc>u<C-r>','3Gci(X<Esc>u','dwu','ddu','Jju','p','xp','xP','yyp','ddp','dwP','vjd','vjdu','Vjdu','guuu','>>u','~u','rXu','3xu','2ddu','G$d0','G$dbu','gg$','ggg_','7G$b','7Gw','7G3w','7Ge','7Gb','7Gdw','7G2dw','7Gd$','7GD','7GC<Esc>','7Gcw<Esc>','4Gci"X<Esc>','4Gdi"','4Gda"','4Gyi"P','3Gci(X<Esc>','3Gdi{','8Gdi[','8Gci<lt>X<Esc>','8Gdit','8Gdat','7Gdis','7Gdas','7G25lcisX<Esc>','7Gvisd','10Gdap','10Gyap','10Gvipd','10Gcip<Esc>','10Gdip']:
    cases.append(['more', c])
seen = set(); out = []
for k, c in cases:
    if c not in seen:
        seen.add(c); out.append([k, c])
json.dump({'text': F, 'cases': out}, open('cases.json', 'w'))
print(len(out), 'cases')
