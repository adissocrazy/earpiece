# Skill packs

A skill pack is a named list of skills. `earpiece pack install` copies every skill in it into each agent that reads skills: Claude Code (`~/.claude/skills`) and Codex (`~/.agents/skills`).

## Where packs come from

| You run | What it reads |
| --- | --- |
| `earpiece pack install team` | `~/.earpiece/packs/team.json`, a pack you saved |
| `earpiece pack install github:org/repo` | a GitHub repo (`@branch` or `@tag` at the end picks a version) |
| `earpiece pack install github:org/repo/sub/dir` | one folder inside a repo |
| `earpiece pack install https://…` or `git@host:org/repo.git` | any git URL |
| `earpiece pack install ./folder` | a folder on disk, such as an export |

Repos are cloned shallowly into `~/.earpiece/tmp` and deleted afterwards. Git never prompts, so private repos need a login git already has: an SSH key or a credential helper.

A pack installed from a repo or folder is saved under its name with the source and the commit it came from. Installing it by name again fetches the source again, so you get the latest.

## The manifest

A repo or folder can hold `earpiece-pack.json`:

```json
{
  "name": "team",
  "description": "What our team uses",
  "skills": [
    { "name": "review", "path": "skills/review" },
    { "name": "deploy", "repo": "github:acme/ops-skills", "path": "skills/deploy", "ref": "main" }
  ]
}
```

- `name`: letters, digits, `.`, `-` and `_`, at most 64 characters. The same rule applies to skill names.
- `path`: a folder with a `SKILL.md`, relative to the manifest. It must stay inside the repo: `..`, absolute paths, `~` and symlinks that lead outside are refused.
- `repo` (optional): take the skill from another repo instead, with an optional `ref`. A shared manifest can't point at `file://` repos.

Without a manifest, Earpiece takes every `skills/<name>/SKILL.md` in the repo. If there are none, it takes a `SKILL.md` at the root as a single skill named after the repo.

Packs you save yourself (`~/.earpiece/packs/*.json`) have the same format, but their local skills use full paths.

## Export

`earpiece pack export <name> <dir>` writes a folder that stands alone:

```
earpiece-pack.json
skills/
  review/SKILL.md
  deploy/SKILL.md
```

Every skill is copied in, including the ones from other repos, so the folder installs without them. This is also the layout `npx skills add` reads. Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_*`) are left out and listed. Exporting into a folder that holds an earlier export replaces its `skills/`. Any other folder must be empty.

Push the folder to GitHub, and anyone can install it:

```
earpiece pack install github:you/team-skills
```

## Safety

- A pack from a repo or folder is always previewed before it installs. The preview lists every skill, how many files it has, and any scripts in it. In the CLI you then pass `--yes`. In the app you click Install.
- Skills are instructions and scripts your agent will follow and run. Only install packs you trust, and read the scripts.
- Installing never deletes anything. A skill that's already there and different is moved to `~/.earpiece/backups/skills/` before it is replaced. `--dry-run` shows what would change.
