import csv, re, unicodedata, random, sys
D='data/'
rows=[l.strip().split('|') for l in open(__import__('os').path.join(__import__('os').path.dirname(__file__),'players.txt')) if l.strip()]
import statistics as st
def zvals(rs):
    L=[]
    for r in rs:
        n,tm,pos,age,gp,mn,fga,fg,fta,ft,tp,reb,ast,stl,blk,tov,sts,inj=r
        fga=float(fga);fta=float(fta);fgm=round(fga*float(fg),1);ftm=round(fta*float(ft),1);tp=float(tp)
        L.append(dict(PTS=2*fgm+tp+ftm,TP=tp,REB=float(reb),AST=float(ast),STL=float(stl),BLK=float(blk),TO=float(tov),fgm=fgm,fga=fga,ftm=ftm,fta=fta))
    return L
def zscores(rs,pool):
    L=zvals(rs);Pl=[L[i] for i in pool]
    fg=sum(x['fgm'] for x in Pl)/sum(x['fga'] for x in Pl);ft=sum(x['ftm'] for x in Pl)/sum(x['fta'] for x in Pl)
    def raw(x,c):
        return x['fgm']-fg*x['fga'] if c=='FG' else x['ftm']-ft*x['fta'] if c=='FT' else x[c]
    C=['PTS','TP','REB','AST','STL','BLK','TO','FG','FT']
    ms={c:st.mean(raw(x,c) for x in Pl) for c in C};sd={c:st.pstdev(raw(x,c) for x in Pl) for c in C}
    return [sum((-1 if c=='TO' else 1)*(raw(x,c)-ms[c])/sd[c] for c in C) for x in L]
pool=list(range(182))
for _ in range(3):
    Z=zscores(rows,pool)
    val=[Z[i]*min(1,int(rows[i][4])/66)-1.2*float(rows[i][17])*(0.6) for i in range(len(rows))]
    zr={i:k for k,i in enumerate(sorted(range(len(rows)),key=lambda i:-val[i]))}
    order=sorted(range(len(rows)),key=lambda i:0.5*i+0.5*zr[i])
    pool=order[:182]
rows=[rows[i] for i in order]
def take(name):
    i=[k for k,r in enumerate(rows) if r[0]==name][0]; return rows.pop(i)
pins=[(11,'Scottie Barnes'),(12,'Karl-Anthony Towns'),(13,'Evan Mobley'),(14,'Chet Holmgren'),(44,'Derrick White'),(60,'Ja Morant'),(92,'Jimmy Butler'),(104,'Tyrese Haliburton'),(128,'Damian Lillard')]
got=[(i,take(n)) for i,n in pins]
for i,r in sorted(got,key=lambda t:t[0]): rows.insert(i,r)
def slug(n):
    n=unicodedata.normalize('NFKD',n).encode('ascii','ignore').decode().lower()
    n=n.replace("'",'').replace('.','')
    return re.sub(r'[^a-z0-9]+','-',n).strip('-')
random.seed(7)
P=[];I=[];A=[]
for rank,r in enumerate(rows,1):
    n,tm,pos,age,gp,mn,fga,fg,fta,ft,tp,reb,ast,stl,blk,tov,st,inj=r
    age=int(age);gp=int(gp);fga=float(fga);fg=float(fg);fta=float(fta);ft=float(ft);inj=float(inj)
    fgm=round(fga*fg,1);ftm=round(fta*ft,1);tp=float(tp)
    pts=round(2*fgm+tp+ftm,1)
    P.append([slug(n),'',n,tm,pos,age,gp,'%.1f'%float(mn),'%.1f'%pts,'%.1f'%fgm,'%.1f'%fga,'%.1f'%ftm,'%.1f'%fta,'%.1f'%tp,reb,ast,stl,blk,tov])
    P[-1][14:19]=['%.1f'%float(x) for x in (reb,ast,stl,blk,tov)]
    status={'h':'healthy','d':'day-to-day','o':'out','s':'out-for-season'}[st]
    rest=min(0.9,max(0.05,0.08+max(0,age-27)*0.025+inj*0.12))
    avail=min(0.98,gp/82*0.97)
    I.append([slug(n),gp,status,'%.2f'%inj,'%.2f'%rest,'%.2f'%avail,'true' if inj>=0.7 else 'false','2026-10-01T00:00:00Z'])
    adp=rank+random.uniform(0.05,0.8)+max(0,rank-110)*0.2
    sd=min(22,max(0.5,0.8+0.12*adp+random.uniform(-0.6,0.6)))
    A.append([slug(n),adp,sd,rank])
for a in A:
    if a[0]=='scottie-barnes': a[1]=12.4
    if a[0]=='karl-anthony-towns': a[1]=13.5
    if a[0]=='derrick-white': a[1]=45.8
for a in A: a[1]='%.1f'%a[1]; a[2]='%.1f'%a[2]
def w(f,h,rs):
    with open(D+f,'w',newline='') as fh:
        c=csv.writer(fh,lineterminator='\n');c.writerow(h);c.writerows(rs)
w('projections.csv','id,yahoo_player_key,name,nba_team,positions,age,games,minutes,pts,fgm,fga,ftm,fta,three_pm,reb,ast,stl,blk,tov'.split(','),P)
w('yahoo-adp.csv',['player_id','yahoo_adp','adp_std_dev','rank'],A)
w('injuries.csv','player_id,projected_games,current_status,injury_history_score,rest_risk,availability_score,major_injury_history,updated_at'.split(','),I)
