# Embeddable agent chat

## CSS variables

Set these on the element or any ancestor; custom properties inherit through the shadow root. An unset variable keeps Orquester's value for the current `mode` and `scheme`. Every build publishes the same list in `/embed/variables.json`.

- **Neutrals**, RGB triples without `rgb()` (`--orq-n-900: 18 18 18`): `--orq-n-50`, `--orq-n-100`, `--orq-n-200`, `--orq-n-300`, `--orq-n-400`, `--orq-n-500`, `--orq-n-600`, `--orq-n-700`, `--orq-n-800`, `--orq-n-900`, `--orq-n-950`
- **Danger**, RGB triples: `--orq-sem-danger-200`, `--orq-sem-danger-300`, `--orq-sem-danger-400`, `--orq-sem-danger-500`, `--orq-sem-danger-600`, `--orq-sem-danger-800`, `--orq-sem-danger-900`, `--orq-sem-danger-950`, `--orq-sem-danger-muted`
- **Warning**, RGB triples: `--orq-sem-warn-50`, `--orq-sem-warn-300`, `--orq-sem-warn-400`, `--orq-sem-warn-500`, `--orq-sem-warn-700`, `--orq-sem-warn-900`, `--orq-sem-warn-950`, `--orq-sem-warn-muted`, `--orq-sem-warn-500-muted`
- **OK**, RGB triples: `--orq-sem-ok-300`, `--orq-sem-ok-400`, `--orq-sem-ok-500`, `--orq-sem-ok-900`, `--orq-sem-ok-vivid`, `--orq-sem-ok-muted`, `--orq-sem-ok-70-muted`
- **Info**, RGB triples: `--orq-sem-info-300`, `--orq-sem-info-400`, `--orq-sem-info-500`, `--orq-sem-info-900`
- **Diff bands**, full colour values (`rgb(5 46 22 / 0.4)`): `--orq-diff-add-bg`, `--orq-diff-add-fg`, `--orq-diff-del-bg`, `--orq-diff-del-fg`
- **Fonts**, full `font-family` values: `--orq-font-sans`, `--orq-font-mono`
