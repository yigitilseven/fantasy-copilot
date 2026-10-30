# Always-on deployment (Ubuntu VPS, Docker)

What runs, all in Docker, nothing on the host except Docker itself:

| Service | What it does |
|---|---|
| `app` | The Draft Copilot web app (production build). Holds `data/` (SQLite, caches) and does the daily upkeep itself (schedule, news, stored brief). Also serves the installable iPhone app (PWA) and sends Web Push. |
| `browser-worker` | A real Chromium in a virtual screen. **You** log in to Yahoo once through your browser (noVNC). Every ~2 h it opens one league page, runs the tested userscript (read-only, no clicks) and closes the page. |
| `scheduler` | Morning brief (Claude, with your subscription), injury alerts, Claude-token expiry warning. No host cron. |
| `caddy` | Only with a domain: automatic HTTPS plus a login in front of the app and the remote browser. |

Notifications go to your iPhone as **Web Push** (the app installed on the Home Screen). Push requires **HTTPS, so a domain**. E-mail (SMTP) is an optional second channel.

Your address: **https://fantasy.example.com** (change `DOMAIN` in `.env` to use another).

```
iPhone / Mac ──https──> Caddy ──> app:3000 ──> data/fantasy.sqlite
                          └─/browser/──> browser-worker (noVNC) ── Chromium ── Yahoo
scheduler ──http──> app (brief, news, push)      browser-worker ──http──> app (sync ingest)
```

Safety: the worker never stores or types your Yahoo password, never solves captchas or 2FA, and never clicks on Yahoo. When Yahoo asks for a login it stops and pushes "Yahoo needs you to log in again" with the link.

---

## 1. Prepare the VPS (Ubuntu 22.04 / 24.04, x86_64 or arm64, 2 GB RAM or more)

```bash
ssh youruser@VPS_IP

# updates + a firewall that only lets SSH and web traffic in
sudo apt update && sudo apt -y upgrade
sudo apt -y install ufw rsync sqlite3 curl
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable

# Docker (official script) and permission to use it without sudo
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out and in again, then check:
docker --version && docker compose version
```

2 GB of RAM is enough; if the first image build runs out of memory, add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`.

## 2. DNS: point fantasy.example.com at the VPS

At your DNS provider for `example.com` create:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `fantasy` | the VPS public IPv4 | 300 (low) |
| AAAA (only if the VPS has IPv6) | `fantasy` | the VPS public IPv6 | 300 |

Check from your Mac (wait a few minutes; it must print the VPS IP):

```bash
dig +short fantasy.example.com
dig +short AAAA fantasy.example.com   # only if you added AAAA
```

* **Cloudflare:** set the record to **DNS only** (grey cloud), not "Proxied" (orange). Caddy needs to reach Let's Encrypt directly. If you want to stay proxied, or cannot open ports 80/443, use the tunnel variant in section 13.
* One record is enough: the remote browser is served at `https://fantasy.example.com/browser/`.

## 3. Get the code onto the VPS (the repo has no remote)

Run on your **Mac**, in the project folder `fantasy-draft-copilot`. Replace `youruser` and `VPS_IP`.

```bash
cd ~/Developer/NbaFantasyWizard/fantasy-draft-copilot
ssh youruser@VPS_IP 'mkdir -p ~/fantasy'

rsync -av --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .claude \
  --exclude 'test-results' --exclude 'playwright-report' --exclude tsconfig.tsbuildinfo \
  --include .env.example --exclude '.env' --exclude '.env.*' \
  --exclude data \
  ./ youruser@VPS_IP:~/fantasy/
```

`--exclude data` keeps your local database and the Yahoo API token file out of this copy. (Option B instead of rsync, a git bundle: `git bundle create /tmp/fantasy.bundle --all`, `scp /tmp/fantasy.bundle youruser@VPS_IP:~`, then on the VPS `git clone ~/fantasy.bundle ~/fantasy`. The bundle only has committed files; rsync also sends your uncommitted changes, which is what you want right now.)

### Bring your data along (league, rosters, history)

On the Mac, make a consistent copy of the SQLite file (safe even while `pnpm dev` is running) and send it plus the caches:

```bash
sqlite3 data/fantasy.sqlite ".backup /tmp/fantasy-copy.sqlite"
ssh youruser@VPS_IP 'mkdir -p ~/fantasy/data/reports ~/fantasy/data/ops ~/fantasy/data/cache'
scp /tmp/fantasy-copy.sqlite youruser@VPS_IP:~/fantasy/data/fantasy.sqlite
rsync -av --exclude 'backup-*' --exclude 'yahoo-tokens.json' --exclude '*.sqlite*' data/ youruser@VPS_IP:~/fantasy/data/
```

On the VPS give the containers (user id 1000) write access:

```bash
cd ~/fantasy
mkdir -p data/reports data/ops data/cache
sudo chown -R 1000:1000 data
```

(If you skip the copy, the app starts with an empty database and you would have to run the seed and `season:init` yourself. Copying is much easier.)

## 4. Fill in `.env`

```bash
cd ~/fantasy
cp .env.example .env
nano .env
```

Every variable is explained in the file. The ones you must set:

1. `TZ` (e.g. `Europe/Istanbul`), `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` (the login for the site; long password), `NOVNC_PASSWORD`, `WORKER_TOKEN` (`openssl rand -hex 24`).
2. `YAHOO_LEAGUE_ID` and `YAHOO_TEAM_ID`: from your Yahoo team URL `https://basketball.fantasysports.yahoo.com/nba/<LEAGUE_ID>/<TEAM_ID>`.
3. **Push keys** (once):
   ```bash
   docker compose build scheduler          # a few minutes the first time
   docker compose run --rm --no-deps scheduler node_modules/.bin/tsx scripts/push-vapid.ts
   ```
   (Or run `pnpm push:vapid` on your Mac. Compose needs `NOVNC_PASSWORD` and `BASIC_AUTH_*` filled in for any command.) Paste `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and put your e-mail in `VAPID_SUBJECT=mailto:you@example.com`. Do not change them later, or every phone has to re-enable notifications.
4. **Claude subscription token** (for the morning brief):
   * On your Mac, or on the VPS with `docker compose run --rm --no-deps -it scheduler claude setup-token`, run `claude setup-token`, log in in the browser it opens, and copy the long token it prints.
   * `CLAUDE_CODE_OAUTH_TOKEN=<token>` and `CLAUDE_TOKEN_CREATED=<today, YYYY-MM-DD>`. It is valid for 1 year; you get a push 14 days before.
   * Do **not** set `ANTHROPIC_API_KEY` anywhere (it would take precedence and bill the API instead of your subscription). It is not passed into any container.
5. Optional e-mail copy of every notification: fill `SMTP_*`. Leave `SMTP_HOST` empty to keep it off.

`.env` holds secrets: `chmod 600 .env`.

## 5. Start

```bash
cd ~/fantasy
docker compose up -d --build        # first build: roughly 5 to 15 minutes
docker compose ps                   # app should become "healthy"
docker compose logs -f --tail=50    # Ctrl-C leaves the logs, the containers keep running
```

Caddy gets the HTTPS certificate on the first request (needs the DNS record from step 2 and ports 80/443 open). Open **https://fantasy.example.com**, log in with `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`, go to `/season`.

## 6. Put the app on your iPhone and turn on notifications

1. On the iPhone open **https://fantasy.example.com/season** in **Safari** (iOS 16.4 or newer) and log in.
2. Share button, **Add to Home Screen**, Add.
3. Open **Draft Copilot from the new Home Screen icon** (not from Safari). iOS only allows push for the installed app.
4. On the Season page tap **Enable notifications**, allow, then **Send test**. You should get a push within seconds.

If the button is not there it tells you what is missing (not installed from Home Screen, notifications blocked in iOS Settings, no HTTPS).

## 7. Log in to Yahoo once (remote browser)

1. Open **https://fantasy.example.com/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify** (a bookmark is handy). Site login first, then the noVNC password (`NOVNC_PASSWORD`).
2. You see a Chromium window already on your league page. **Log in to Yahoo yourself** (tick "Stay signed in"; do any 2FA or captcha by hand). The login is stored in the persistent profile volume, you do not type anything again until Yahoo asks.
3. Leave the window as it is. The worker opens its own tab for each sync and closes it.

You will get the push "Yahoo needs you to log in again: open ..." whenever Yahoo asks again (tap it, log in, done). Typically every few weeks.

## 8. First sync, and check that everything works

```bash
cd ~/fantasy
source <(grep -E '^WORKER_TOKEN=' .env)
curl -s -X POST -H "Authorization: Bearer $WORKER_TOKEN" "http://127.0.0.1:8081/sync?wait=1"   # takes 2 to 4 minutes
curl -s -H "Authorization: Bearer $WORKER_TOKEN" http://127.0.0.1:8081/status
```

Expected `{"outcome":"ok"}`. Then the **/season** page shows green chips (Roster, Teams, Matchup...). Other outcomes: `login` (do step 7), `no-league` (the database has no season league: copy it in step 3), `skipped` (daily cap, quiet hours or min gap; manual runs ignore quiet hours), `partial`/`timeout` (see Troubleshooting).

Test notifications and the brief:

```bash
docker compose exec scheduler pnpm notify --test                                   # push (and e-mail if configured)
docker compose exec scheduler node_modules/.bin/tsx scripts/ops-scheduler.ts brief  # morning brief now
docker compose exec scheduler claude -p "Reply with OK" --allowedTools Read          # is the Claude token accepted?
```

The brief arrives as a short push ("62% this week · Start: ... · Move: add ...") and the full text is on `/season` under **Claude analysis**. If Claude is unavailable the push says "engine only" and the plain engine brief is used.

Schedule (all in the scheduler container, your `TZ`): brief at `BRIEF_TIME` (default 08:30, after asking the worker for a fresh sync), injury check every `INJURY_WATCH_MINUTES` (a status change of a player on your roster pushes immediately: engine facts, plus a short Claude take, rate limited to 6 per day), token expiry check daily. The app itself keeps the NBA schedule and news fresh.

## 9. No domain / bare IP: SSH tunnel (no push)

Remove (or comment) `COMPOSE_PROFILES=domain` in `.env` and run `docker compose up -d`. Caddy is not started and nothing is exposed publicly: the app listens on `127.0.0.1:3000` and the remote browser on `127.0.0.1:6080` only (never open those ports in the firewall). From your Mac:

```bash
ssh -L 3000:localhost:3000 -L 6080:localhost:6080 -L 8081:localhost:8081 youruser@VPS_IP
```

then http://localhost:3000/season and http://localhost:6080/vnc.html?autoconnect=1&resize=scale (log in to Yahoo there). **This mode works without push notifications**: browsers only allow Web Push on https, so the iPhone cannot be notified. Use e-mail (`SMTP_*`) as the alert channel instead, or switch to the domain mode.

## 10. Updating

From the Mac (same rsync as step 3, without the data part), then on the VPS:

```bash
cd ~/fantasy && docker compose up -d --build
```

Database migrations apply automatically. Volumes (Yahoo login, Claude config, `data/`) are kept. `docker image prune -f` frees old images.

## 11. Backups

The important state: `data/fantasy.sqlite` (league, rosters, history), the Chromium profile volume (the Yahoo login, optional) and `.env`.

```bash
# consistent SQLite copy while the app is running; keep 14 days
mkdir -p ~/backups
sqlite3 ~/fantasy/data/fantasy.sqlite ".backup ~/backups/fantasy-$(date +%F).sqlite"
find ~/backups -name 'fantasy-*.sqlite' -mtime +14 -delete
```

Run it daily with `crontab -e`: `15 4 * * * sqlite3 $HOME/fantasy/data/fantasy.sqlite ".backup $HOME/backups/fantasy-$(date +\%F).sqlite"`. Download occasionally: `scp youruser@VPS_IP:backups/fantasy-*.sqlite .`. Restore: `docker compose stop app scheduler`, copy the file to `data/fantasy.sqlite` (delete `data/fantasy.sqlite-wal` and `-shm`), `sudo chown 1000:1000 data/fantasy.sqlite`, `docker compose start app scheduler`.

## 12. Troubleshooting

| Symptom | What to do |
|---|---|
| Push "Yahoo needs you to log in again" | Tap it (or open the `/browser/` link), log in to Yahoo by hand, then run a manual sync (step 8) or wait for the next run. The flag clears by itself and you get "login is working again". |
| `docker compose ps` shows app unhealthy | `docker compose logs app`. Usual causes: `data/` not owned by uid 1000 (`sudo chown -R 1000:1000 data`), a corrupt copy of the database. |
| Browser shows a certificate error / Caddy cannot get a certificate | The DNS record is missing or wrong (`dig +short fantasy.example.com`), Cloudflare proxy is on (set "DNS only"), ports 80/443 closed (`sudo ufw status`, provider firewall). `docker compose logs caddy`. |
| Brief says "(Plain engine brief: Claude login/token problem)" | The token is wrong or expired: run `claude setup-token` again, update `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_TOKEN_CREATED` in `.env`, `docker compose up -d`. Check `docker compose exec scheduler claude -p "OK"`. Make sure no `ANTHROPIC_API_KEY` is in `.env`. |
| "Plain engine brief: Claude rate limit" | Your subscription's usage window is used up; it resets by itself. Lower `INJURY_CLAUDE` use (`INJURY_CLAUDE=0`) or the number of runs. |
| `claude` rejects a flag | The CLI changes. The scheduler uses `-p --output-format json --permission-mode dontAsk --allowedTools Read` (never `--bare`). Extra flags only through `CLAUDE_EXTRA_ARGS`. Check `docker compose exec scheduler claude --help`. |
| Sync outcome `partial` / `timeout` | Yahoo answered with an error or slowly (rate limit). It retries at the next run; the 2 h pace and the daily cap (`MAX_SYNCS_PER_DAY`) are polite on purpose. Look at `docker compose logs browser-worker` and the chips on `/season`. A red "Parser needs update" chip means a Yahoo page layout changed; a sample was saved under `data/cache/`. |
| "Enable notifications" missing / does nothing | iPhone: open the app from the Home Screen icon (not Safari), iOS 16.4+. Settings > Notifications > Draft Copilot must be allowed. After re-installing the app tap Enable again (old subscriptions are removed automatically when the push service reports them gone). |
| No push but the app works | `docker compose exec scheduler pnpm notify --test` prints the reason ("no device has enabled notifications", "push is not configured": VAPID keys missing). |
| Remote browser is black / frozen | `docker compose restart browser-worker` (the Yahoo login is kept in the profile volume). |
| Disk filling up | `docker system df`, `docker image prune -f`; logs are capped at 3 x 10 MB per container. |

Useful: `docker compose logs -f scheduler browser-worker`, `docker compose restart <service>`, `docker compose down` (keeps volumes) and `docker compose down -v` (also deletes the Yahoo login, Claude config and Caddy certificates; **not** `data/`).

## 13. Variant: Cloudflare Tunnel instead of open ports (proxied DNS)

Use this if you cannot open 80/443 or want Cloudflare in front. (Not tested on a real VPS; the pieces are standard.) Install `cloudflared` on the VPS and create a tunnel (`cloudflared tunnel login`, `cloudflared tunnel create fantasy`, `cloudflared tunnel route dns fantasy fantasy.example.com`) that forwards `fantasy.example.com` to `http://localhost:80`. In `.env` set:

```
DOMAIN=http://fantasy.example.com        # plain http between the tunnel and Caddy; Cloudflare provides the https
NOVNC_PUBLIC_URL=https://fantasy.example.com/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify
COMPOSE_PROFILES=domain
```

and close ports 80/443 in the firewall (Caddy's port 80 is then only reached by the tunnel on the same host; bind it to `127.0.0.1:80:80` in `docker-compose.yml` if you want to be strict). The login (basic auth) still protects everything.

## 14. Keep using the Safari userscript at home

The always-on worker already does the league sync, so at home you mainly need the userscript for **draft day**.

* **Default, nothing to change:** the Mac keeps running `pnpm dev` and the userscript talks to `http://localhost:3000` as before (it is unchanged unless something injects `window.__FDC_ORIGIN`).
* **Use the VPS app from the Mac with the same userscript:** open a tunnel `ssh -L 3000:localhost:3000 youruser@VPS_IP` (stop local `pnpm dev` first). `http://localhost:3000` then is the VPS app; no login needed through the tunnel.
* **Point the userscript at the public address:** edit `origin` in `extension/userscript.src.js` to `https://fantasy.example.com`, run `pnpm ext:build`, reinstall the script (the header already allows `@connect fantasy.example.com`). The site login must be remembered by Safari (open https://fantasy.example.com once and log in); userscript requests can fail on the login prompt, so prefer the tunnel for draft day.

The draft board itself (`/draft`) is a draft-day Mac tool; on the iPhone use `/season` (brief, moves, injuries, notifications).
