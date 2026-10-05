# Personal ZotFlow fork

This is the persistent project context for `tparsons9/zotflow` on `personal`.
It documents the customized build used in `~/vaults/tanners-vault`, including
annotation profiles and category layouts. Upstream attribution, plugin identity,
and version numbers are preserved.

Read [README.md](README.md) for the upstream product and development guide and
[AGENTS.md](AGENTS.md) for its architecture, coding conventions, and tests.
[AGENTS.override.md](AGENTS.override.md) explicitly loads both that guide and this
file. This file's personal branch, installation, and release rules take precedence
over the upstream release policy for work in this fork.

## Agent rules for this fork

- `personal` is this fork's default and persistent working branch. It preserves
  the existing annotation PRs and upstream development base; do not reset it to a
  stable release or rewrite the PR branches.
- Contributions use separate branches from the owner's intended base. Personal
  reminder/installation tooling and the fork reader URL do not belong in upstream PRs.
- On `personal`, `.gitmodules` points at `tparsons9/obsidian-zotero-reader`;
  publish custom reader commits before parent commits referring to them.
- Adopt stable upstream tags through reviewed merges, coordinating the custom
  reader pin. Update `.github/upstream-state.json` only for changes actually adopted.
  Preserve plugin ID, command IDs, upstream versions and author attribution.
- The weekly watcher may write only update issues/labels in `tparsons9/zotflow`.
  Do not publish releases or dispatch the owner's Enhancement Pack workflows from
  this fork. The inherited publishing jobs are guarded by repository identity.
- `npm run install:personal` runs tests and the full build before copying regular
  artifacts into `~/vaults/tanners-vault`. Close readers and disable ZotFlow first;
  enable it afterward. Use `--dry-run` to preview and `status:personal` to verify.
  Never point the isolated harness or Hot Reload at the personal vault.
- `.personal/` holds gitignored receipts/backups. Preserve vault settings, notes,
  sidecars, credentials and Enhancement Pack contents. Rollback must verify hashes
  and reject unknown/different database schemas; files do not reverse migrations.
- See this document's Personal maintenance section for the complete update/install loop.

## Keeping upstream updates manageable

Keep personal context in this file and reader-specific context in
[reader/reader/PERSONAL.md](reader/reader/PERSONAL.md). Keep the upstream READMEs,
parent `AGENTS.md`, and `.github/workflows/ci.yml` free of personal additions.
They currently match the adopted parent development base
`6a65f704441f5a88e543d9bb7542702c14947960`; the reader README matches its adopted
owner base `e6dfec2857b1e008a416832e1bd9df868513b035`. During future merges, accept
upstream documentation changes and update personal context here when needed.
Keep the small override files tracked so new checkouts retain these instructions.

`.github/workflows/personal-ci.yml` checks pushes and pull requests targeting
`personal` in this fork. It runs the upstream tests, personal tooling tests, full
build, and reader tests. `npm run test:personal` runs the installer and reminder
regressions independently; it is also required by the personal installer.

Some shared changes still require review:

| Files                                                      | Personal change to preserve during a merge                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Annotation source and tests in both repositories           | Profile behavior, ordinary creation-time tags, and source-note categories    |
| `reader/reader` gitlink                                    | Exact reviewed reader commit, published before the parent pin                |
| `.gitmodules`                                              | Personal reader fork URL                                                     |
| `package.json`                                             | Additive personal commands; preserve upstream test commands                  |
| `.gitignore`, `eslint.config.mts`                          | Ignore local `.personal/` receipts and backups                               |
| Release, beta, and Enhancement Pack notification workflows | Repository guards preventing owner publishing jobs from running in this fork |

A conflict occurs when Git cannot combine overlapping changes. These shared files
can still conflict, even though separating the documentation removes our current
personal edits from upstream documentation and CI. Review functional conflicts
individually. Do not add blanket merge drivers or force an entire file to ours.
If upstream later introduces a file with one of our personal filenames, reconcile
that addition explicitly.

Both current repositories enable Git's recorded conflict resolutions locally:

```bash
git config --local rerere.enabled true
git config --local rerere.autoupdate false
git -C reader/reader config --local rerere.enabled true
git -C reader/reader config --local rerere.autoupdate false
```

Repeat these commands for a fresh clone; repository-local configuration is not
tracked. Git can reuse an earlier resolution when the same conflict returns.
Reused resolutions remain unstaged for review: inspect the diff, run the relevant
checks, then stage the result. This does not eliminate conflicts or validate code.

## Personal maintenance

This fork keeps a customized build on `personal`, while contribution PR branches
remain separate. The current base includes upstream development work after stable
1.6.6, including database schema 7. Future stable releases are merged into this
history; the build is not represented as stock 1.6.6 merely because its manifest
still carries the upstream version.

The reader is a pinned submodule of `tparsons9/obsidian-zotero-reader`. Push reader
commits to that fork before pushing parent commits that reference them. A fresh
checkout uses `git clone --recurse-submodules`, then `npm ci`. Configure the reader's
owner remote once with:

```bash
git -C reader/reader remote add upstream https://github.com/duanxianpi/obsidian-zotero-reader.git
```

**Reminders:** the weekly workflow checks stable ZotFlow releases and upstream reader
`master` commits every Monday at 15:17 UTC. Issues are created only in
`tparsons9/zotflow`, assigned to `tparsons9`, and labeled `upstream-update`. They do
not appear in the parent's issue list, although a public fork's issues are public.
Repeated targets produce no new notification; new targets update the corresponding
open issue and mention you. Closing an issue acknowledges its recorded targets
without changing the adopted baseline. Reader alerts can describe divergent branches:
upstream ZotFlow currently pins a reader commit from a different upstream branch.

```bash
npm run upstream:check -- --dry-run  # read-only diagnostic; needs gh auth or GH_TOKEN
gh workflow run upstream-check.yml --repo tparsons9/zotflow --ref personal
```

On upstream ZotFlow, select **Watch → Custom → Releases**. In GitHub's notification
settings, enable email for watching and participation/mentions, and enable Actions
failure notifications. Subscribe to each update issue. Schedules run on the default
branch and public repositories can lose scheduled execution after 60 days without
activity. If that happens, re-enable **Check upstream updates** in the fork's Actions
tab and manually dispatch it. Release email is the independent fallback.

**Adopt an update:** create a review branch from `personal`. Fetch upstream changes
in both repositories. Inspect the exact stable release tag and its reader pin
(`git ls-tree <tag> reader/reader`). Merge needed upstream reader changes on a reader
review branch, preserving annotation profiles; publish its reviewed result to the
reader's `personal` branch. Merge the exact ZotFlow release tag into the parent
review branch and resolve code conflicts individually. Keep the fork URL in
`.gitmodules`, check out the merged custom reader, and `git add reader/reader` to
record its exact pin. Do not blindly choose an entire side of a submodule conflict.

Run plugin and reader tests and the full build. Update `.github/upstream-state.json`
with the stable tag/commit and upstream reader commit actually integrated, keeping
the original development-base provenance. Merge the reviewed parent result into
`personal`, push it, and close the update issue. Independent reader updates use the
same process without changing the recorded ZotFlow stable release. Feature work
branches from `personal`; upstream contributions are prepared separately from the
owner's intended base, without personal tooling or submodule URL changes.

**Install:** close reader tabs and disable ZotFlow in the destination vault first.
Then run:

```bash
npm run install:personal -- --dry-run
npm run install:personal
npm run status:personal
```

The default vault is `~/vaults/tanners-vault`; all three commands accept
`--vault "/another/vault"`. Installation requires a clean `personal` branch and
initialized, clean submodules at their committed pins. It runs `npm test`, `npm run test:personal`, the
reader's tests, and `npm run build:ci` before copying anything. This always rebuilds
the reader rather than bundling stale assets. Enable ZotFlow again afterward.

Only `main.js`, `manifest.json`, `styles.css`, and the generated reader license
notice are managed. Settings, notes, annotation sidecars, credentials, and existing
Enhancement Pack contents are preserved. Ordinary copies keep everyday use separate
from the isolated harness's Hot Reload links. Do not add this installation to BRAT
or use the community directory's Update action: those would replace your custom
build. `status:personal` verifies hashes even when both builds have the same version.

Receipts and timestamped backups live under gitignored `.personal/`, keyed by vault.
The receipt records the parent/reader commits, upstream provenance, database schema,
and installed artifact hashes. A failed copy restores the previous artifact set.
For a verified backup from a prior personal build with the same database schema:

```bash
npm run rollback:personal -- --backup <id> --dry-run
npm run rollback:personal -- --backup <id>
```

Disable ZotFlow before rollback and enable it afterward. **Artifact rollback does
not undo database migrations or settings changes.** Unknown-schema installations
(including the original community build) are backed up but cannot be restored by
the automated rollback command. Cross-schema recovery needs separate review; never
delete IndexedDB to force a downgrade when it may hold unsynced edits. Run upgrade
tests only in the isolated profile with a dedicated Zotero test library.

## Annotation profiles

Open **Settings → ZotFlow → Annotation Profiles** to create or duplicate a profile,
rename it, and edit/reorder its colors and optional labels. The protected **Zotero
default** keeps the original eight colors; duplicate it to customize it. Ink and
text retain the extra black option. A profile needs at least one color, and colors
within a profile must be distinct six-digit hex values.

The default profile applies to newly opened readers. The profile chooser inside a
reader changes only that open reader; reconnecting retains its choice, while
reopening the document starts with the settings default. Profile edits update
open readers. Removing their active profile falls back to the default. Existing
annotations keep their colors and tags, including colors removed from a palette.

Labels are display text. **Automatically tag new annotations** is a separate,
default-off option that adds a labeled entry's text as an ordinary Zotero annotation
tag at creation. It preserves other tags and avoids duplicates. It never retags
annotations when recoloring, editing, importing, or switching profiles.

Source-note labels resolve in this order:

1. An ordinary annotation tag matching a current or remembered category label.
   Matching is exact and case-sensitive; manually added matching tags count too.
   If several match, the earliest registered category wins.
2. The annotation color's label in the **settings default profile**. Temporary
   reader selections do not change source-note fallback labels.
3. **Other** if neither resolves.

ZotFlow remembers committed label names in its settings even after a label or
profile is deleted. This keeps tagged annotations' meaning stable across profile
changes. Share ZotFlow's settings between devices to retain that registry; Zotero
stores only ordinary colors and tags. Untagged older annotations use the current
color fallback, so their inferred display labels may change.

Under **General → Source Notes**, two default-off settings control built-in output:

- **Group annotations by category** creates category sections across attachments.
  Groups follow default-profile palette order, then historical registry order,
  with Other last. Within a group, annotations follow attachment key, document
  position, then annotation key. A category literally named Other shares the final
  group with uncategorized annotations.
- **Labeled annotation callout titles** applies when grouping is off. The original
  type/color callout remains, with its label as title and its attachment/page link
  in the body. Its preference is retained while grouping is on.

Both layouts preserve annotation links, images, block references, editable comments,
and user-owned persist regions. Settings apply on the next render; use **Force
update source note** (or **Force update all library source notes**) to refresh
unchanged library notes, and the local source-note update action for local files.

Custom templates remain authoritative. The options do not rewrite them. Every
annotation context adds `paletteLabel`, `categoryTags`, `category`, `resolvedLabel`,
and `labelSource` (`tag`, `color`, or `none`). `item.annotationGroups` and
`attachment.annotationGroups` expose `{ label, annotations }` groups; existing
annotation arrays retain their original order. `annotation.attachmentTitle` is
available for grouped attachment links. These are template fields only, not
annotation storage fields.

For example, a custom library template can opt into grouped output with:

```liquid
{% capture quote_prefix %}{{ newline }}> {% endcapture %}
{% for group in item.annotationGroups %}
## {{ group.label | annotation_label }}
{% for annotation in group.annotations %}
> [!quote] {{ annotation.resolvedLabel | default: "Other" | annotation_label }}
> [p.{{ annotation.pageLabel }}]({{ annotation | annotation_link }})
> {{ annotation.text | replace: newline, " " }}
>
> {{ annotation.comment | wrap_editable: "ANNO", annotation.key | replace: newline, quote_prefix }}
^{{ annotation.key }}
{% endfor %}
{% endfor %}
```

Use the `annotation_label` filter when inserting labels into Markdown headings or
callout titles: labels are plain text. The snippet illustrates text annotations;
retain your template's image and persist-region handling, or use the built-in
layouts for all annotation types. The template preview's built-in template includes
the selected presentation options and is a complete starting point for customization.

## Live annotation regression

The local-only annotation profile regression needs no Zotero key. After building
and launching the isolated app, run `node tests/live/annotation-profiles.live.mjs`.
It creates named fixtures in the test vault and restores profile settings afterward.

See the upstream [live testing guide](README.md#live-testing-in-obsidian) for
launching the isolated app. Never launch this harness against the personal vault.
