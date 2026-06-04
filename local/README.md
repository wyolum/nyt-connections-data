# Running the scraper nightly on a Mac mini

This replaces the (flaky) GitHub Actions schedule with a local `launchd` job that
runs from the mini's residential IP — which NYT treats like a normal browser —
and on a scheduler you control. The GitHub Actions workflow is left in place as a
manual/cloud fallback (a no-op commit if the data is already up to date).

Run everything below **on the Mac mini.**

## 1. Install prerequisites

```bash
# Homebrew (skip if already installed): https://brew.sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node + git
brew install node git
```

## 2. Give the mini push access to GitHub (SSH)

The mini has no key yet, so create one and add it to your GitHub account:

```bash
ssh-keygen -t ed25519 -C "macmini-nyt-connections" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that public key into GitHub → **Settings → SSH and GPG keys → New SSH key**.
(Or, if you'd rather scope it to just this repo, add it as a *Deploy key* with
"Allow write access" under the repo's **Settings → Deploy keys**.)

Verify:

```bash
ssh -T git@github.com   # should greet you by username
```

## 3. Clone the repo (via SSH so pushes work headlessly)

```bash
git clone git@github.com:wyolum/nyt-connections-data.git ~/nyt-connections-data
cd ~/nyt-connections-data
```

## 4. Install the scheduler

```bash
bash local/install.sh
```

This writes `~/Library/LaunchAgents/com.wyolum.nyt-connections.plist`, loads it,
and prints a `pmset` command. If the mini ever sleeps, run that command (it needs
`sudo`) so the machine wakes for the 03:10 job:

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 03:07:00
```

> Even without `pmset`, `launchd` runs a *missed* scheduled job the moment the
> mini next wakes — so you'll still get the data, just later in the morning.

## 5. Test it immediately

```bash
bash local/run-scrape.sh
tail -f local/logs/*.log
```

You should see tiles extracted and either a push or "No data changes to commit."

## How it works

- **`run-scrape.sh`** — pulls latest, installs deps on first run, runs
  `scraper/scrape.mjs`, then commits & pushes `docs/data/*.json` only if changed.
  Locks against overlapping runs and logs to `local/logs/`.
- **`install.sh`** — generates and loads the `launchd` agent for 03:10 local time.
- The scraper itself was hardened to **wait for the 16 tiles to render** (instead
  of a fixed delay) and to **retry up to 3×**, which removes most slow-load flakiness.

## Managing the job

```bash
launchctl list | grep nyt-connections                 # is it loaded?
launchctl unload ~/Library/LaunchAgents/com.wyolum.nyt-connections.plist   # stop
launchctl load   ~/Library/LaunchAgents/com.wyolum.nyt-connections.plist   # start
sudo pmset -g sched                                    # see scheduled wakes
```

## Optional: stop the GitHub Actions schedule

The cloud run is kept as a fallback. If the occasional duplicate run bothers you,
comment out the `schedule:` block in `.github/workflows/scrape.yml` (keep
`workflow_dispatch` so you can still trigger it manually).
