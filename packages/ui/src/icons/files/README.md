# File-type icons

A vendored subset of [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
(`material-icon-theme@5.38.1`, MIT — see `LICENSE`), the VS Code explorer's file icons, used by the
agent-chat attachment chips (`lib/file-icon.ts` maps an extension/mime to one of these ids).

To refresh or add an icon: `curl -sSf https://cdn.jsdelivr.net/npm/material-icon-theme@<version>/icons/<name>.svg -o <name>.svg`,
then check it has no `<style>`, `<image>`, `id=` or `url(#…)` (the files are inlined into one DOM) and add the id to
`FILE_ICON_IDS` and `FILE_ICONS` — the id is the file's name, and `file-icon.test.ts` checks that each id imports its
own `<id>.svg`. Brand-shaped Office icons are deliberately not used (trademark guidelines forbid decorative use);
`word`/`powerpoint`/`table` are generic pictograms.
