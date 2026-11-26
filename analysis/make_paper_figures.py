"""Regenerates paper Figures 2-6 from results/analysis (summary.json, runs.csv, effects_A_vs_B.csv).
Usage: python analysis/make_paper_figures.py [repo_root]
Writes docs/figures/fig2_primary, fig3_sensitivity, fig4_faults, fig5_cost, fig6_framework (.png and .pdf).
Figure 1 (testbed) is docs/figures/fig_testbed.*. Requires pandas and matplotlib.
"""
import json, pandas as pd, numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import os, sys
REPO=sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')
R=os.path.join(REPO,'results','analysis')+os.sep
OUT=os.path.join(REPO,'docs','figures')
runs=pd.read_csv(R+'runs.csv'); S=json.load(open(R+'summary.json')); E=pd.read_csv(R+'effects_A_vs_B.csv')
A,B,C='#2a78d6','#eb6834','#7a7974'; INK='#0b0b0b'; MUTED='#52514e'; GRID='#e6e5e1'
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':9,'axes.edgecolor':MUTED,'axes.labelcolor':INK,
 'xtick.color':MUTED,'ytick.color':MUTED,'axes.spines.top':False,'axes.spines.right':False,'axes.grid':True,
 'grid.color':GRID,'grid.linewidth':0.6,'axes.axisbelow':True,'savefig.dpi':300,'savefig.bbox':'tight'})
def save(f,n):
    f.savefig(os.path.join(OUT,n+'.png')); f.savefig(os.path.join(OUT,n+'.pdf')); plt.close(f)

# Fig 3: primary cell
P=runs[runs.cell=='P']
f,(a1,a2)=plt.subplots(1,2,figsize=(7.2,3.0),gridspec_kw={'width_ratios':[1,1.25]})
rng=np.random.default_rng(1)
for i,(arm,col,lab) in enumerate([('A',A,'A: ledger'),('B',B,'B: coordinator'),('C',C,'C: key server')]):
    v=P[P.arm==arm].L95_ms/1000
    a1.scatter(i+rng.uniform(-.12,.12,len(v)),v,s=18,color=col,edgecolor='white',linewidth=.6,zorder=3)
    a1.plot([i-.25,i+.25],[v.median()]*2,color=INK,lw=1.6,zorder=4)
    a1.text(i+.3,v.median(),f'{v.median():.2f}',va='center',fontsize=8,color=INK)
a1.set_xticks([0,1,2],['A: ledger','B: coordinator','C: key server']); a1.set_ylabel('L95 key-arrival latency (s)')
a1.set_ylim(0,3.2); a1.set_title('(a) L95 per run, primary cell (20 runs per arm)',fontsize=9,loc='left')
d=np.sort(np.array(S['H1']['differencesMs']))/1000; lo,hi=S['H1']['exactCI']['lower']/1000,S['H1']['exactCI']['upper']/1000
a2.axvspan(lo,hi,color=A,alpha=.15,lw=0,label='Exact 95.86% CI of median')
a2.scatter(d,np.arange(1,21),s=18,color=A,edgecolor='white',linewidth=.6,zorder=3)
a2.axvline(np.median(d),color=INK,lw=1.4); a2.axvline(5,color=INK,lw=1.2,ls='--'); a2.axvline(0,color=MUTED,lw=.8)
a2.text(5,20.6,'δ = 5 s',ha='right',fontsize=8,color=INK); a2.text(np.median(d)+.08,1,f'median {np.median(d):.2f} s',fontsize=8,color=INK)
a2.set_xlim(-.3,5.5); a2.set_ylim(0,22); a2.set_yticks([1,5,10,15,20]); a2.set_ylabel('Pair (sorted)')
a2.set_xlabel('Paired difference Δ = L95(A) − L95(B) (s)'); a2.set_title('(b) H1: paired differences vs margin',fontsize=9,loc='left')
a2.legend(loc='center right',fontsize=7.5,frameon=False)
f.tight_layout(); save(f,'fig2_primary')

# Fig 4: sensitivity forest
order=['P','M10','M200','K5N9','JIT30','LOAD20','BP1','BP5','POLL200','POLL1000','EX1','EX20']
lab={'P':'Primary (M=50, k/n=3/5)','M10':'M = 10 centres','M200':'M = 200 centres','K5N9':'(k, n) = (5, 9)','JIT30':'Trustee jitter U(0, 30 s)',
'LOAD20':'Background load 20/s','BP1':'Block period 1 s','BP5':'Block period 5 s','POLL200':'Polling 200 ms','POLL1000':'Polling 1000 ms','EX1':'Exam 1 MB','EX20':'Exam 20 MB'}
e=E[E.metric=='L95'].set_index('cell').loc[order]
NETF=os.path.join(REPO,'results','exploratory','net50-summary.json')
net=json.load(open(NETF)) if os.path.exists(NETF) else None
nrow=len(order)+(1 if net else 0)
f,ax=plt.subplots(figsize=(6.4,3.8+(0.32 if net else 0))); y=np.arange(nrow)[::-1][:len(order)]
for yi,(c,r) in zip(y,e.iterrows()):
    col=INK if c=='P' else A
    m=r.median_diff_A_minus_B/1000
    ax.errorbar(m,yi,xerr=[[m-r.diff_exact_lo/1000],[r.diff_exact_hi/1000-m]],fmt='o',ms=5.5,color=col,mec='white',mew=.8,elinewidth=1.6,capsize=0,zorder=3)
    from decimal import Decimal as D, ROUND_HALF_UP as H
    q=lambda v: str(D(str(v/1000)).quantize(D('0.01'),rounding=H))
    ax.text(5.45,yi,f'{q(r.median_diff_A_minus_B)} [{q(r.diff_exact_lo)}, {q(r.diff_exact_hi)}]',va='center',fontsize=7.5,color=MUTED)
yt=list(y); yl=[lab[c] for c in order]
if net:
    from decimal import Decimal as D2, ROUND_HALF_UP as H2
    q2=lambda v: str(D2(str(v/1000)).quantize(D2('0.01'),rounding=H2))
    m=net['diff_L95_median_ms']/1000; lo,hi=[v/1000 for v in net['diff_exact_ci_ms']]
    ax.errorbar(m,0,xerr=[[m-lo],[hi-m]],fmt='o',ms=5.5,color='white',mec=C,mew=1.4,ecolor=C,elinewidth=1.6,capsize=0,zorder=3)
    ax.text(5.45,0,f"{q2(net['diff_L95_median_ms'])} [{q2(net['diff_exact_ci_ms'][0])}, {q2(net['diff_exact_ci_ms'][1])}]",va='center',fontsize=7.5,color=MUTED)
    ax.axhline(0.5,color=MUTED,lw=.6,ls=':')
    yt.append(0); yl.append('+50 ms network delay (exploratory)')
ax.axvline(5,color=INK,ls='--',lw=1.2); ax.axvline(0,color=MUTED,lw=.8); ax.text(4.95,nrow-.4,'δ = 5 s',ha='right',fontsize=8)
ax.set_yticks(yt,yl); ax.set_xlim(-.3,5.3); ax.set_ylim(-.7,nrow-.1)
ax.set_xlabel('Median paired Δ L95 (A − B), s, with exact CI (20 pairs: 95.86%; 10 pairs: 97.85%)')
ax.text(5.45,nrow-.4,'median [CI], s',fontsize=7.5,color=MUTED)
ax.grid(axis='y',visible=False); f.tight_layout(); save(f,'fig3_sensitivity')

# Fig 5: fault matrix
F=pd.DataFrame(S['faults']); tests=['F1','F2','F3','F4','F5','F6','F7','F8','G1']
desc={'F1':'2 of 5 trustees absent','F2':'3 of 5 trustees absent','F3':'Corrupted share','F4':'Share before T0','F5':'Clock +30 s on one node',
'F6':'Coordinator / node censors 5 centres','F7':'One replica killed at T0','F8':'Record tampered after release','G1':'Trustee set changed after setup'}
f,ax=plt.subplots(figsize=(6.0,3.6)); ax.set_xlim(0,2); ax.set_ylim(0,len(tests)); ax.axis('off')
for j,arm in enumerate(['A','B']):
    ax.text(j+.5,len(tests)+.25,['A: ledger','B: coordinator'][j],ha='center',fontsize=9,weight='bold')
    for i,t in enumerate(tests):
        r=F[(F.test==t)&(F.arm==arm)].iloc[0]; yy=len(tests)-1-i; ok=r.passed==10
        ax.add_patch(plt.Rectangle((j+.04,yy+.06),.92,.88,facecolor=(A if arm=='A' else B) if ok else 'white',
            alpha=.85 if ok else 1,edgecolor=MUTED if not ok else 'none',hatch=None if ok else '///',lw=.8))
        ax.text(j+.5,yy+.5,f"{r.passed}/10  {'PASS' if ok else 'FAIL'}",ha='center',va='center',fontsize=8.5,
            color='white' if ok else INK,weight='bold' if ok else 'normal',
            bbox=None if ok else dict(facecolor='white',edgecolor='none',pad=1))
for i,t in enumerate(tests):
    ax.text(-.05,len(tests)-1-i+.5,f'{t}  {desc[t]}',ha='right',va='center',fontsize=8.5)
ax.plot([-1.6,2],[5,5],color=MUTED,lw=.6,ls=':',clip_on=False)
save(f,'fig4_faults')

# Fig 6: cost
rc=S['referenceC']['metrics']; cp=S['cells']['P']['metrics']
f,axs=plt.subplots(1,3,figsize=(7.2,2.6))
for ax,(m,ttl) in zip(axs,[('cpu_s','CPU-seconds per session'),('mem_MB','Peak memory, MB (sum of\nper-container peaks)'),('storage_MB','Storage growth, MB')]):
    vals=[(cp[m]['medianA'],cp[m]['ciA'],A),(cp[m]['medianB'],cp[m]['ciB'],B),(rc[m]['medianA'],rc[m]['ciA'],C)]
    for i,(md,ci,col) in enumerate(vals):
        ax.bar(i,md,width=.55,color=col,edgecolor='none')
        ax.plot([i,i],ci,color=INK,lw=1); 
        ax.text(i,max(ci[1],md)+ax.get_ylim()[1]*0.0,f'{md:.3f}' if 0<md<0.1 else f'{md:.2f}' if md<10 else f'{md:.0f}' if md>=100 else f'{md:.1f}',ha='center',va='bottom',fontsize=7.5)
    ax.set_xticks([0,1,2],['A','B','C']); ax.set_title(ttl,fontsize=8.5,loc='left'); ax.grid(axis='x',visible=False)
    ax.margins(y=.15)
f.tight_layout(); save(f,'fig5_cost')

# Fig 2: decision framework
f,ax=plt.subplots(figsize=(7.4,4.0)); ax.axis('off'); ax.set_xlim(0,10.4); ax.set_ylim(0,6)
def box(x,y,w,h,t,fc='white',bold=False,fs=8):
    ax.add_patch(FancyBboxPatch((x-w/2,y-h/2),w,h,boxstyle='round,pad=0.02,rounding_size=0.12',fc=fc,ec=MUTED,lw=1))
    ax.text(x,y,t,ha='center',va='center',fontsize=fs,weight='bold' if bold else 'normal',color=INK)
def arr(x1,y1,x2,y2,t='',dx=0,dy=.1):
    ax.annotate('',(x2,y2),(x1,y1),arrowprops=dict(arrowstyle='-|>',color=MUTED,lw=1))
    if t: ax.text((x1+x2)/2+dx,(y1+y2)/2+dy,t,fontsize=7.5,color=MUTED,ha='center')
box(2.2,5.2,4.0,.9,'Q1. Is one operator trusted not to leak\nor release the key early?')
box(2.2,3.4,4.0,.9,'Q2. Do all parties accept one replicated\nservice run by a single admin domain?')
box(2.2,1.5,4.0,1.1,'Q3. In the benchmark, is A within the\nrelease budget δ (H1) and does it pass\nF5, F6 and F8? (this study: yes)')
box(7.9,5.2,4.4,.9,'C   Central key server (no threshold)',fc='#ececea',bold=True,fs=7.8)
box(7.9,3.4,4.4,.9,'B   Threshold + replicated coordinator\nEvidence: F1–F4, F7 pass; 1.3 s lower L95',fc='#fbe1d6',fs=7.6)
box(7.9,2.05,4.4,.8,'A   Threshold + smart contract\nEvidence: H1 within δ; F5, F6, F8, G1 at 10/10',fc='#d7e6f8',fs=7.6)
box(7.9,0.75,4.4,.8,'Fallback: B + an independent\nappend-only audit log',fs=7.6)
arr(4.2,5.2,5.7,5.2,'yes'); arr(2.2,4.75,2.2,3.85,'no',dx=.2,dy=0); arr(4.2,3.4,5.7,3.4,'yes'); arr(2.2,2.95,2.2,2.05,'no',dx=.2,dy=0)
arr(4.2,1.8,5.7,2.05,'yes'); arr(4.2,1.2,5.7,0.8,'no',dy=-.25)
save(f,'fig6_framework')
