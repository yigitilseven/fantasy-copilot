# Relaxed copy of validate.py for Yahoo-imported data (real data legitimately differs: variable player count,
# rookies/bigs with extreme FG%/FT%, long-term injuries with few projected games, no 'bench <=20 pts' shape).
# Usage: python3 scripts/data/validate_yahoo.py [data_dir]
import csv
import sys,os
D=(sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','data'))+'/'
P=list(csv.DictReader(open(D+'projections.csv')));A=list(csv.DictReader(open(D+'yahoo-adp.csv')));I=list(csv.DictReader(open(D+'injuries.csv')))
errs=[]
def chk(c,m):
    if not c: errs.append(m)
chk(len(P)==len(A)==len(I)>=1,f'counts {len(P)},{len(A)},{len(I)}')
ids=[p['id'] for p in P]
chk(len(set(ids))==len(ids),'dup ids')
chk(ids==[a['player_id'] for a in A]==[i['player_id'] for i in I],'id mismatch/order')
g=lambda p,k:float(p[k])
for p in P:
    n=p['name'];fgm,fga,ftm,fta,tp=[g(p,k) for k in('fgm','fga','ftm','fta','three_pm')]
    chk(fgm<fga and ftm<=fta and tp<=fgm,n+' attempts');
    chk(.30<=fgm/fga<=.80,f'{n} FG% {fgm/fga:.3f}');chk(.30<=ftm/fta<=1.0,f'{n} FT% {ftm/fta:.3f}')
    chk(abs(g(p,'pts')-(2*fgm+tp+ftm))<=.3,n+' pts');chk(8<=int(p['games'])<=80,n+' games')
    chk(len(p['nba_team'])==3,n+' team')
pr=None
for i,a in enumerate(A):
    v=float(a['yahoo_adp']);chk(int(a['rank'])==i+1,'rank');chk(pr is None or v>pr,'adp order '+a['player_id']);pr=v
for p,i in zip(P,I):
    chk(int(i['projected_games'])==int(p['games']),'games '+p['id'])
    chk(i['current_status'] in('healthy','day-to-day','out','out-for-season'),'status')
top=P[:25];avg=sum(g(p,'pts') for p in top)/max(1,len(top))
print('top25 avg pts %.1f'%avg)

print('ERRORS:',errs if errs else 'none');print('rows',len(P))

