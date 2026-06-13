# Deploying your own pa-framework

> Audience: anyone setting up their own pa-framework deployment — most users (Pattern A), or contributors who maintain substrate (Pattern B).

The framework is published as `coderexpert123/pa-framework`. To use it for your own personal assistant, you'll want a deployment that:

- Lets you add personal projects, skills, and data without leaking them to the public framework.
- Stays in sync with substrate updates from the canonical repo.
- Matches your collaboration needs (solo use? contributing back? team?).

This doc covers two patterns. Pick one based on how you'll work.

---

## §1 Two patterns at a glance

| | **Pattern A — Simple fork** | **Pattern B — Dual-`.git`** |
|---|---|---|
| **Repos** | 1 (your private fork/copy) | 2 (1 public substrate + 1 private companion, same working tree) |
| **Difficulty** | Easy — standard Git workflow | Advanced — manages two `.git` directories |
| **Best for** | Most users; quick personal deployment | Contributors who actively push substrate fixes back upstream |
| **Substrate updates** | `git pull upstream main` | `git pull` on the public side only |
| **Risk of leaking personal data** | Low — single private repo | Low if `.gitignore-private` whitelist is correct; needs care |

**Decision rule:** Just want to use the framework + add your own skills? Pattern A. Want to contribute substrate fixes back upstream while keeping personal stuff private? Pattern B.

---

## §2 Pattern A: Simple fork (recommended for most)

A single private repo seeded with the framework. You commit everything (substrate + personal) to it. To pull upstream substrate updates, add `coderexpert123/pa-framework` as a remote and merge.

### Option A1 — Fork-then-private (when pa-framework is PUBLIC visibility)

1. Visit https://github.com/coderexpert123/pa-framework and click **Fork**.
2. The fork is created as PUBLIC (GitHub's default for forks of public repos).
3. Go to your fork's **Settings → Danger Zone → Change repository visibility → Make private** and confirm.
4. Clone locally:
   ```powershell
   git clone https://github.com/<you>/pa-framework.git
   cd pa-framework
   ```

### Option A2 — Import to a fresh private repo (always works)

Use this if pa-framework is still PRIVATE visibility, or you want a clean independent repo:

1. Create a new empty PRIVATE repo on GitHub (e.g., `<you>/my-pa`). Don't initialize with a README.
2. Clone pa-framework locally as a starting point:
   ```powershell
   git clone https://github.com/coderexpert123/pa-framework.git my-pa
   cd my-pa
   ```
3. Repoint origin to your new private repo:
   ```powershell
   git remote remove origin
   git remote add origin https://github.com/<you>/my-pa.git
   git push -u origin main
   ```

Now you have an independent private repo seeded with the framework's current state.

### Customizing

- **Skills you run**: `~/.pa/skills/<your-skill>/` (outside the repo, in `PA_HOME`).
- **Personal projects (code you write)**: `projects/<your-name>/` inside your private repo. Since the whole repo is private, personal projects stay private.
- **Personal data (medical, financial, family, photos)**: outside the repo entirely → `~/Documents/personal-imports/<date>/` per [`CONVENTIONS.md`](CONVENTIONS.md).
- **Runtime state** (config, secrets, profile, logs): `~/.pa/` — `PA_HOME`, outside the repo.

### Pulling substrate updates

Add the canonical pa-framework as an `upstream` remote, then merge updates:

```powershell
git remote add upstream https://github.com/coderexpert123/pa-framework.git
git fetch upstream
git merge upstream/main
```

If you've modified files that the upstream also changed (e.g., you customized `pa/src/foo.ts`), resolve the conflicts manually. For substrate files you don't touch, the merge is clean.

---

## §3 Pattern B: Dual-`.git` (advanced — for substrate contributors)

Two `.git` directories in the same working tree. Substrate files tracked by BOTH (so you can push fixes back upstream). Personal additions tracked only by the private repo.

> **CAUTION**: This pattern is the inverse of the maintainer's setup. The maintainer's PRIVATE repo is `.git/`, their PUBLIC mirror is `.git-public/`. For you (a contributor), it's the other way around: public substrate is `.git/`, private companion is `.git-private/`. Pattern A is simpler — use Pattern B only if you genuinely contribute back to substrate.

### Step-by-step

1. **Clone pa-framework as your `.git/`** (your working tree's primary remote = public substrate):
   ```powershell
   git clone https://github.com/coderexpert123/pa-framework.git
   cd pa-framework
   ```

2. **Initialize a separate `.git-private/`** in the same working tree:
   ```powershell
   git --git-dir=.git-private --work-tree=. init --initial-branch=main
   git --git-dir=.git-private config core.worktree "$(pwd)"
   git --git-dir=.git-private config core.excludesFile "$(pwd)/.gitignore-private"
   git --git-dir=.git-private config core.autocrlf false
   git --git-dir=.git-private config user.email "<your-email>"
   git --git-dir=.git-private config user.name "<your-name>"
   ```

3. **Create `.gitignore-private`** as a whitelist (deny everything, then `!` re-include personal paths). Pattern follows the maintainer's `.gitignore-public` (in the public framework repo's root) — adapt to your needs. Skeleton:
   ```gitignore
   # .gitignore-private — whitelist personal additions; deny everything else
   /*

   # Re-include personal projects + plans + brain files
   !/.gitignore-private
   !/projects/
   !/plans/
   !/BACKLOG.md
   !/CLAUDE.md
   !/MEMORY.md

   # Inside projects/: only YOUR personal projects (deny the substrate ones)
   projects/*
   !projects/<your-name>/

   # Universal noise excludes
   **/__pycache__/
   **/venv/
   **/node_modules/
   **/dist/
   ```

4. **Create wrapper scripts** for ergonomic ops:

   `git-private.cmd` (Windows):
   ```batch
   @echo off
   git --git-dir="%~dp0.git-private" --work-tree="%~dp0." %*
   ```

   `git-private.ps1` (PowerShell / cross-platform):
   ```powershell
   $repoRoot = Split-Path -Parent $PSCommandPath
   & git --git-dir="$repoRoot\.git-private" --work-tree="$repoRoot" @args
   ```

5. **Create a private repo on GitHub** for the private side (e.g., `<you>/my-pa-private`). Add as remote:
   ```powershell
   ./git-private remote add origin https://github.com/<you>/my-pa-private.git
   ```

6. **Verify the whitelist works** BEFORE any commit:
   ```powershell
   ./git-private status
   ```
   Should list only personal files. If it lists substrate files (e.g., `pa/src/foo.ts`), your `.gitignore-private` is too permissive — fix before committing.

### Daily workflow

- **Substrate edit (e.g., bug fix in `pa/src/`)**: `git add pa/src/foo.ts && git commit && git push` — goes to the public substrate (your fork or PR-target).
- **Personal edit (e.g., your project under `projects/<your-name>/`)**: `./git-private add projects/<your-name>/foo.py && ./git-private commit && ./git-private push` — goes to your private companion.
- **The same working tree serves both repos**; commit to whichever based on what changed.

### Substrate updates

Same as Pattern A's upstream pull pattern, but on the `.git/` side: `git fetch origin && git merge origin/main`.

---

## §4 Where files go

For the full file-placement decision tree, see [`CONVENTIONS.md`](CONVENTIONS.md). Quick essentials:

| What | Where |
|---|---|
| Framework code (CLI / worker / lib / bot) | `pa/src/` or `projects/telegram-bot/src/` — substrate, shared |
| Your personal projects | `projects/<your-name>/` inside your private repo |
| Skills you run | `~/.pa/skills/<name>/` — outside repo, in `PA_HOME` |
| Runtime config + secrets | `~/.pa/config.yaml`, `~/.pa/secrets.env` — outside repo |
| Runtime OAuth helpers + resume hook | `~/.pa/google_*.json`, `~/.pa/google_auth.py`, `~/.pa/oauth_resume_hook.py` — outside repo |
| Personal docs (medical, financial, family) | `~/Documents/personal-imports/<date>/` — outside repo |
| Ad-hoc / throwaway / WIP scripts | `scratch/` — inside repo but gitignored (both repos) |
| Framework docs (you author for community) | `docs/` — substrate, shared |
| Personal plans / brain / backlog | `plans/`, `CLAUDE.md`, `MEMORY.md`, `BACKLOG.md` — private only |

If you use the Telegram/mobile Google auth flow, deploy
`projects/google-oauth-redirect/` to any static HTTPS host and keep the actual
OAuth client JSON, token file, pending-auth state, and resume hook under
`~/.pa/` rather than inside either repo.

---

## §5 Choosing your deployment

A short flowchart:

```
Will you have personal data in your deployment?
├── Yes → keep your repo PRIVATE (both patterns support this)
└── No  → could use a public repo, but you probably want Pattern A anyway

Will you actively contribute fixes back to public substrate?
├── Yes → Pattern B (dual-`.git`): substrate changes can be pushed
│         independently of personal changes
└── No  → Pattern A: simpler workflow; you can still send PRs by
         cherry-picking commits, but it's not the optimized path

Need CI / GitHub Actions on the substrate?
├── Easier with Pattern A (single repo)
└── Workable with Pattern B but adds complexity (CI must know which
    `.git` to test against)
```

**Most users**: Pattern A, Option A1 (after pa-framework flips to public) or Option A2 (right now while it's private).

**Power users / substrate contributors**: Pattern B.

---

## See also

- [`QUICKSTART.md`](QUICKSTART.md) — build, configure, and run your first skill
- [`CONVENTIONS.md`](CONVENTIONS.md) — full file-placement rules
- [`BOT_GUIDE.md`](BOT_GUIDE.md) — Telegram bot setup
- [`CONFIGURATION.md`](CONFIGURATION.md) — `config.yaml` + `secrets.env` reference
- The maintainer's `.gitignore-public` (in the public framework's working tree) is the reference whitelist pattern for Pattern B's `.gitignore-private`
