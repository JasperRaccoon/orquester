# T3 Code — the design language, ported to Orquester

**Audience:** the engineers building the agent chat GUI's timeline (W12), composer and banners
(W13), roster and status line (W14), and the shell that holds them (W15).

**Purpose:** you should be able to build a surface that looks and *moves* like T3 Code without
opening T3. Every claim below is cited `path:lines` against the pinned read-only clone at
`/var/lib/orquester/workspaces/jaspersito/orquester/.t3code` (commit `adcd908`), so when a number
looks arbitrary you can go read why it is not.

**Scope:** this is the visual layer only. Behaviour is the spec
(`docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §7); the component inventory is
`t3-3-web-ui.md`. Where the spec says "differs:", the spec wins and this document follows it.

**What ships with this document:**

| Artifact | What it is |
|---|---|
| `packages/ui/src/styles/agent-chat.css` | Every keyframe and `ac-*` utility named here, themed with Orquester's variables, each with a reduced-motion fallback |
| `packages/ui/src/components/agent-chat/primitives/` | The twelve shared primitives, typed and documented |

Use them. A second shimmer, a second status dot or a second disclosure is how four components stop
being one interface.

---

## 0. The four laws

T3's chat UI is not a pile of pretty defaults; it is four rules applied relentlessly. If you
internalise nothing else, internalise these — most of the "feels wrong" bugs in a port are a
violation of one of them.

### Law 1 — Motion is duty-cycled, never continuous

Every looping indicator **holds** a value for most of its period and ramps in `steps(n)`, so the
compositor draws a handful of discrete frames per cycle instead of one per vsync.

> *"Duty-cycled indicator animations: long holds with stepped ramps, so the compositor updates
> discrete frames instead of every vsync."*
> — `apps/web/src/index.css:149-150`

> *"…one opacity pulse per container, stepped so however many bars sit under it, the compositor
> draws a handful of discrete frames per cycle rather than one per vsync — which on a 120Hz display
> is the difference between ~14 and ~288 updates."*
> — `apps/web/src/index.css:214-217`

This is a product rule, not a micro-optimisation. T3's own guide states it:

> *"Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label.
> No continuously repainting animations; they peg the GPU on high-refresh displays."*
> — `.t3code/AGENTS.md`, "Taste"

**In our port:** `ac-status-pulse` uses `steps(6)`, `ac-skeleton` `steps(4)`, `ac-status-ping`
`steps(8)`, `ac-shimmer` `steps(30)`. Do not "smooth them out".

### Law 2 — Off-screen means off

Every looping animation is play-state gated on a CSS variable that a shared `IntersectionObserver`
flips, together with `document.visibilityState` and `prefers-reduced-motion`.
*T3: `apps/web/src/lib/visibleAnimation.ts:10-18`; consumed at `index.css:457, 463, 516, 529`*

**In our port:** `useVisibleAnimation()` sets `--ac-anim-state`. `ShimmerText`, `StatusDot` and
`MeterRing` attach it for you. If you hand-write an `ac-*` looping class, attach it yourself.

*Deliberate difference:* T3 defaults the variable to `paused`, so a forgotten ref means a silently
dead indicator. Ours defaults to `running` — with several authors building chat surfaces in
parallel, a shimmer that keeps running off-screen is a far cheaper mistake than one that never
starts.

### Law 3 — Changing data must never change layout

> *"Agent rows reserve three fixed lines for identity, activity, and metrics; changing data must
> never change their height."*
> *"Static status dots, DOM-write elapsed timers, plain token counters."*
> — `apps/web/src/components/AgentsPanel.tsx:5-11`

Three mechanics enforce it:

1. **Fixed row geometry.** The roster row is `h-[3.875rem]` with explicit
   `grid-rows-[1.25rem_1.125rem_1rem]` — a longer description truncates, it does not wrap.
   *T3: `AgentsPanel.tsx:158`*
2. **Tabular figures everywhere a number ticks.** `ac-tabular` on elapsed timers, token counts,
   `1/N` counters, percentages. A proportional `1` is narrower than a `0`; without this a
   once-a-second tick visibly twitches the row.
3. **DOM-write timers.** A live counter writes `textContent` directly and costs **zero React
   commits**. *T3: `AgentsPanel.tsx:82-113`* — use `ElapsedTicker`.

### Law 4 — Colour is spent on three meanings

> *"Five visual states, three colors: color is reserved for 'act now' (approval), 'in motion'
> (working), and 'broken' (failed). Ready is the unlabeled resting state…"*
> — `apps/web/src/components/Sidebar.logic.ts:805-812`

Resting is uncoloured and unlabelled. Two corollaries T3 learned in live tests:

- **Idle reads as settled.** An idle-but-resumable agent is muted, never live-coloured.
  > *"Idle reads as settled (muted, not sky): a resting Codex child looks done unless resumed —
  > live-test: sky idle dots read as stuck in-progress."* — `AgentsPanel.tsx:42-43`
- **All in-flight states present as one steady look.** `pending`, `running` and `waiting` are all
  "Working"; only settled states differentiate.
  > *"…a stalled/waiting/queued subagent is still the fleet doing its job, not a user problem."*
  > — `AgentsPanel.tsx:32-37`

---

## 1. Layout

### 1.1 The shell

```
┌─ ChatView root ──────────────────────────────────────────────┐
│ header                                                       │
│ ┌─ chat column (relative) ───────────┐┌─ right panel ───────┐│
│ │ ┌ banner overlay (absolute, z-20) ┐││  (inline ≥980px,    ││
│ │ │  thread error / provider status │││   sheet below)      ││
│ │ └─────────────────────────────────┘││                     ││
│ │  timeline scroller (flex-1)        ││                     ││
│ │    row: mx-auto max-w-3xl          ││                     ││
│ │    …                               ││                     ││
│ │    footer spacer = composer height ││                     ││
│ │ ┌ scroll-to-end pill (abs, z-30) ─┐││                     ││
│ │ └─────────────────────────────────┘││                     ││
│ │ ┌ composer overlay (abs, z-20) ───┐││                     ││
│ │ │  banner dock (attached)         │││                     ││
│ │ │  composer surface               │││                     ││
│ │ └─────────────────────────────────┘││                     ││
│ └────────────────────────────────────┘└─────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

| Element | Recipe | Cite |
|---|---|---|
| ChatView root | `relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-neutral-950` | `ChatView.tsx:9758` |
| Chat column | `relative flex min-h-0 min-w-0 flex-1 flex-col` | `ChatView.tsx:9837-9839` |
| Messages wrapper | `relative flex min-h-0 flex-1 flex-col bg-neutral-950` | `ChatView.tsx:9876` |
| Banner overlay | `pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col` | `ChatView.tsx:9860` |
| Composer overlay | `pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2` | `ChatView.tsx:9988-9996` |
| Scroll pill | `pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5` | `ChatView.tsx:9964-9968` |

**The composer is an overlay, not a flex child.** This is load-bearing and easy to get wrong: it
lets the composer grow without moving the messages behind it, and it is why follow-scroll
explicitly does *not* re-pin on footer layout (spec §7.3). The timeline instead reserves space with
a footer spacer whose height is the composer's published height.
*T3: `ChatView.tsx:9943` (`contentInsetEndAdjustment`), `:5900-5917` (publish),
`MessagesTimeline.tsx:367-374` (the spacer)*

The published height is `Math.ceil(getBoundingClientRect().height)`, republished on resize and
reset to 0 on thread switch. While the composer is resting (collapsed), the inset is
`max(currentInset, overlayHeight + 94)` — 94px is what the composer will grow by when focused: 8px
of top padding + the prompt going 32px → 70px + the 48px footer rejoining the flow.
*T3: `apps/web/src/components/chat/composerFooterLayout.ts` — `COMPOSER_RESTING_EXPANSION_MIN_PX = 94`*

**Overlay z-order:** banners `z-20`, composer `z-20`, scroll pill `z-30`, drop overlay `z-40`.
Orquester's existing ladder sits above all of it (toasts `z-[95]`, modals `z-[100]`, sheets
`z-[110]`, dropdowns/tooltips `z-[120]`), so a chat overlay can never cover a modal.

### 1.2 Content column and gutters

| Token | Value | Cite |
|---|---|---|
| Content max width | `max-w-3xl` = **48rem / 768px** | `MessagesTimeline.tsx:1244`, `.logic.ts:45` |
| Page gutter | `px-3` → `sm:px-5` (12 → 20px) | `MessagesTimeline.tsx:1314-1317` |
| Composer gutter | `ps-[calc(env(safe-area-inset-left)+0.75rem)] sm:ps-[calc(…+1.25rem)]` | `ChatView.tsx:9998-10000` |
| List head spacer | `h-3 sm:h-4` | `MessagesTimeline.tsx:337` |
| Bottom safe spacer | `h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(…+1.25rem)]` | `ChatView.tsx:10224-10227` |

The composer's gutter deliberately matches the timeline's, so the composer's edges line up with the
message column above it. **Keep them in sync** — a 1px mismatch is instantly visible.

Every row is `mx-auto w-full min-w-0 max-w-3xl overflow-x-clip`. `min-w-0` is not optional: without
it a long unbroken token (a path, a base64 blob) blows the flex column out and the whole timeline
scrolls sideways.

> **Orquester note:** our shell already owns the safe-area insets on `#root > *` and sizes from
> `visualViewport` (AGENTS.md, "Mobile safe-area insets"). Per spec §7.8, chat **inherits** that and
> adds nothing — no `pb-safe` on an in-flow chat component, or the bottom inset is applied twice.

### 1.3 Row rhythm

Vertical spacing is **bottom padding on the row shell**, not a `gap` on the list. This lets each row
kind declare its own relationship to the next one.
*T3: `MessagesTimeline.tsx:1669-1701`*

| Row kind | Padding |
|---|---|
| Expanded tool-group member | `pb-1` |
| Expanded group header | `pb-0` |
| Turn fold, working row | `pb-1.5` |
| Assistant text (no meta), reasoning, work, work-live, work-toggle, activity-group, thinking | `pb-2` |
| User message, assistant + meta, plan card, queued bubble | `pb-4` |

The pattern: **activity rows cling together (8px), conversation turns breathe (16px).** A stream of
tool calls should read as one block of work, not as twenty separate events.

### 1.4 Indentation

There is **no connector rail and no tree line.** Hierarchy is one number: `ms-7` (1.75rem) on a
nested body, which is exactly the 24px icon slot plus the 6px gap, so nested content aligns under
the parent's *label* rather than under its icon.
*T3: `MessagesTimeline.tsx:2857, 4997, 5045`*

The changed-files tree is the exception, because it is a real tree: `paddingLeft = 8 + depth * 14`
px, applied inline. *T3: `ChangedFilesTree.tsx:183`*

### 1.5 Composer geometry

| Token | Value | Cite |
|---|---|---|
| Outer surface radius | **22px** | `ComposerSurface.tsx:22, 51` |
| Inner surface radius | **20px** | `ChatComposer.tsx:6317` |
| Banner top radius (attached) | **16px** | `ComposerBanner.tsx:55` |
| Banner radius (floating) | `1rem` | `ComposerBanner.tsx:56` |
| Drawer inset (banner narrower than composer) | **1.375rem / 22px** each side | `ComposerSurface.tsx:17` |
| Banner → composer overlap | `calc(1rem + 1px)` = **17px** | `ComposerBanner.tsx:55` |
| Body padding | `px-3 pb-2 sm:px-4` + `pt-3.5 sm:pt-4` | `ChatComposer.tsx:6375-6384` |
| Footer padding | `px-3 pb-3 sm:px-4 sm:pb-4` | `ChatComposer.tsx:6906-6916` |
| Prompt height | `min-h-17.5` (70px) → `max-h-50` (200px) | `ComposerPromptEditorTiptap.tsx:729-736` |
| Resting footer | floats `absolute bottom-px right-px h-12` | `ChatComposer.tsx:6906-6916` |
| Composer shadow | `0 12px 28px -18px rgb(0 0 0/40%)` | `ComposerSurface.tsx:51` |
| Prompt font size | 14px, forced ≥16px on coarse pointer < 640px | `ComposerPromptEditorTiptap.tsx:1250-1252` |

**The inner radius is 2px smaller than the outer.** That is the concentric-radius rule: a nested
rounded box must subtract its own inset from the parent's radius or the corners look pinched.

**The ≥16px prompt on touch is not a style choice** — iOS Safari zooms the viewport on focus of any
input under 16px, and the zoom does not undo itself.

**Banners are narrower than the composer and overlap it by 17px.** They read as a *drawer pulled out
of* the composer, not as a card resting on it. Our `BannerCard` implements this as
`rounded-t-xl border border-b-0` — square bottom, no bottom border, so the composer closes the
shape. Do not add a bottom border "for symmetry"; it turns the drawer into a floating card.

> **Deliberate simplification.** T3 draws the composer's glass backdrop with a hand-written
> `clip-path: shape(…)` so one continuous blurred surface flows around the banner seam and the
> context strip (`ComposerSurface.tsx:29` — a ~40-term path with bezier controls at `9.85px`/`7.16px`
> and a circle-kappa factor of `0.4477`). We do not port that. Our banner and composer are separate
> bordered boxes that share an edge. Reproducing the seam is weeks of CSS for an effect nobody can
> name, and it does not survive a theme swap across seven schemes.

### 1.6 Roster geometry

```
grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto]
     grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1
```
*T3: `AgentsPanel.tsx:158`*

Three fixed lines, 62px total: **identity** (title + role chip + elapsed), **activity** (one
truncated line), **metrics** (`model · N tok · N tools · run N`). The 6px first column is the dot
lane. List container is `flex flex-col gap-2 p-2` (`:549`).

> **Spec deviation (§7.6):** ours sits under the composer rather than in a right panel, rows are
> clickable (drill-in to a per-agent timeline), rows past five collapse behind "N more", and settled
> rows fade at turn end. T3 does none of those. The fixed-height rule still applies to all of them,
> and a live background row is exempt from both the collapse and the fade.

### 1.7 Breakpoints

T3 runs three thresholds and they disagree in the 640–767px band.
*T3: `hooks/useMediaQuery.ts:3-11`, `rightPanelLayout.ts:1`, `ChatComposer.tsx:2079`*

| Threshold | Used for |
|---|---|
| `< 640px` (`max-sm`) | composer collapse, autofocus suppression, Enter-never-sends |
| `< 768px` (`max-md`) | sidebar becomes a sheet |
| `≤ 980px` | right panel becomes a sheet |

Plus **JS container breakpoints** for the composer footer: `620px` compact, `780px` wide-actions,
with a **1px hysteresis slack** to stop a "Maximum update depth exceeded" flip-flop.
*T3: `composerFooterLayout.ts:1-2, 171-177`*

> **Spec §7.8:** we run **one** breakpoint for all of it, deliberately. Use Tailwind's `sm:`
> (640px). Do not reintroduce the three-threshold split. If you ever measure a container width in
> JS, copy the hysteresis slack too.

---

## 2. Scale

### 2.1 Type

T3 has **no `@tailwindcss/typography`** and zero `prose-*` classes; every text style is explicit.
Sizes cluster tightly — the whole chat lives between 10px and 14px.

| Role | Class | Notes | Cite |
|---|---|---|---|
| Message body | `text-sm leading-relaxed` | 14px / 1.625 — the only "comfortable" text | `ChatMarkdown.tsx:3334-3344` |
| Row label (tool, activity, reasoning) | `text-sm leading-relaxed` | same size, muted colour does the demoting | `MessagesTimeline.tsx:3200-3205` |
| Meta / timestamp / banner body | `text-xs` | 12px | `MessagesTimeline.tsx:2440-2447` |
| Banner type scale | `text-xs/4` | 12px on a 16px line box | `ComposerBanner.tsx:164` |
| Secondary meta, approval header | `text-[11px]` | 11px — usually with `leading-4` | `ComposerPendingApprovalPanel.tsx:44` |
| Counters, tiny metrics, uppercase labels | `text-[10px]` | uppercase labels add `font-medium uppercase tracking-wider` | `ComposerPendingUserInputPanel.tsx:200-204` |
| Roster metrics / role chip | `text-[.7rem]` / `text-[.65rem]` mono | 11.2 / 10.4px | `AgentsPanel.tsx:165, 170, 186` |
| Code block | `13px` default, user-adjustable | `--font-size-code` | `index.css:1602-1605` |
| Inline code | `0.75rem` (12px) | in a 14px sentence, so it never towers | `index.css:1818-1825` |
| Tool output (expanded) | `font-mono text-[length:var(--font-size-code,0.6875rem)]` | 11px floor | `MessagesTimeline.tsx:4546-4547` |

**Weights:** `font-medium` (500) for titles, row identity and emphasis; **600** only for markdown
headings and table headers; everything else 400. There is no 700 anywhere in the chat.

> **Orquester mapping.** We have no `text-[11px]` step in the preset, but the codebase already uses
> the arbitrary value ~60 times (`settings/ModelProxySettings.tsx`, `topbar/UsageWidget.tsx`,
> `ui/upload-progress.tsx`), usually as `text-[11px] leading-4`. Keep that idiom. Our body font is
> Inter (`globals.css:422`); `font-mono` falls through to Tailwind's default stack.

### 2.2 Spacing

The chat uses a deliberately short list of steps. `gap-1.5` (6px) is the signature — it is what
sits between an icon and its label almost everywhere.

| Step | Use |
|---|---|
| `gap-0.5` (2px) | Adjacent icon buttons in a cluster |
| `gap-1` (4px) | Banner grid columns, kbd caps |
| `gap-1.5` (6px) | **Icon ↔ label.** The default inside any row |
| `gap-2` (8px) | Row ↔ row, meta items, roster columns |
| `gap-3` (12px) | Compaction separator, changed-files header groups |
| `px-0.5 py-0.5` | Activity/tool row padding (rows are nearly flush) |
| `px-2 py-1.5` | Menu/list row (Orquester house default) |
| `px-3 py-2` | Card interior |

Note how *small* the tool-row padding is: `px-0.5 py-0.5` with `min-h-6`. Activity rows are almost
flush with the column edge — the hover background is what gives them their shape, not padding.

### 2.3 Radii

| Radius | Use | Cite |
|---|---|---|
| `rounded` (4px) | Kbd cap, micro icon button, role chip (`rounded-sm`) | `ui/kbd.tsx:9` |
| `rounded-md` (6px) | **The default.** Every row, button, hover target | `MessagesTimeline.tsx:4920-4927` |
| `rounded-lg` (8px) | Changed-files card, expanded panels | `ChangedFilesTree.tsx:51` |
| `rounded-xl` (12px) | Banner top corners (ours; T3 uses 16px) | — |
| `rounded-2xl` (16px) | Message bubble | `MessagesTimeline.tsx:2092` |
| `22px / 20px` | Composer outer / inner | `ComposerSurface.tsx:22` |
| `rounded-full` | Status dot, scroll pill, send button | — |

### 2.4 Borders

**One weight: 1px.** There is no 2px border anywhere in the chat except the drag-drop overlay
(`border-2 border-dashed`, `ChatView.tsx:9846-9848`) and a markdown blockquote's left rule
(`2px`, `index.css:1784-1788`).

Hairlines are usually *translucent*: T3 writes `border-border/60`, `bg-border/70`. In our tokens
that is `border-neutral-800` at full strength, or `border-neutral-800/60` where a softer rule is
wanted. The compaction separator uses `h-px flex-1 bg-neutral-800`.

### 2.5 Icons

| Context | Size | Cite |
|---|---|---|
| **Row icon** | **16px** (`size-4`) with `stroke-[1.8]`, centred in a **24px** slot | `MessagesTimeline.tsx:3208-3219` |
| Chevron | 12px (`size-3`) in a 16px slot | `MessagesTimeline.tsx:2847-2851` |
| Failure mark, copy/check, banner icon | 12px | `MessagesTimeline.tsx:4976` |
| Queued-chip clock, turn-fold chevron | 14px (`size-3.5`) | `MessagesTimeline.tsx:1803-1807` |
| Tree glyphs | 14px | `ChangedFilesTree.tsx:204` |
| Empty-state glyph | 24px+, `strokeWidth 1.25` | `AgentsPanel.tsx:536` |

**The 16px-icon-in-a-24px-slot is the single most structural number in the timeline.** It sets the
24px row height, the 6px gap, and the `ms-7` nesting indent. Get it wrong and every nested body
misaligns.

> **Orquester mapping.** We size lucide icons with the numeric `size={N}` prop, never `w-4 h-4`
> (house style, ~30 sites). So: `size={16}` for row icons, `size={12}` for chevrons and marks,
> `size={13}-{14}` for dense-row affordances. Add `strokeWidth={1.8}` on row icons to match T3's
> weight — lucide's default 2 reads heavy at 16px against muted text.

### 2.6 Control heights

| Height | Control | Cite |
|---|---|---|
| **20px** | Micro icon button (queued bubble's send/cancel), kbd cap | `MessagesTimeline.tsx:1815-1819`; `ui/button.tsx:24-25` |
| **24px** | Timeline row, banner dismiss, code-block action, scroll pill | `ui/button.tsx:30-31` |
| **28px** | Composer control, context meter trigger, existing `IconButton` | `ContextWindowMeter.tsx:45-48` |
| **32px** | Composer send / stop (`sm:` step down from 36px) | `ComposerPrimaryActions.tsx:222` |
| **62px** | Roster row (fixed) | `AgentsPanel.tsx:158` |

`components/ui/icon-button.tsx` starts at 28px, which is right for a toolbar and too big for a 24px
chat row. Use **`ChatIconButton`** (`micro` 20 / `xs` 24 / `sm` 28) inside chat surfaces.

---

## 3. Colour roles

T3's palette is semantic (`--primary`, `--muted-foreground`, `--destructive`, …) over seven themes.
Ours is the remapped `neutral` scale plus the `--sem-*` status scale, over seven schemes × light and
dark. **Never port a T3 colour literally.** Port the *role*.

The scale is **perceptual, not lexical**: `--n-50` is the strongest foreground and `--n-950` the
page background **in both modes**. Reading it as "50 = light" is the number-one theming bug.

### 3.1 Surfaces

| Role | T3 | Orquester | Notes |
|---|---|---|---|
| Page / timeline background | `bg-background` | `bg-neutral-950` | Matches `GitView.tsx:258` |
| Card / popover / composer | `bg-card` / `bg-popover` | `bg-neutral-900` | Modal, dropdown, palette all use this |
| Sunken sub-surface | `bg-muted/40` | `bg-neutral-900/60` | Segmented-control track |
| Expanded tool-output panel | `bg-muted/40` | `bg-neutral-900/60` | `MessagesTimeline.tsx:5017` |
| Row hover | `hover:bg-accent/20` | `hover:bg-neutral-800/40` | Deliberately faint — see §6.3 |
| Row selected | `bg-accent` | `bg-neutral-800` | |
| User message bubble | `bg-message` | `bg-neutral-800` | The only filled bubble |

### 3.2 Borders and text

| Role | Orquester |
|---|---|
| Hairline (default) | `border-neutral-800` |
| Hairline (nested, inside an `-800` block) | `border-neutral-900` |
| Input / control border | `border-neutral-700` |
| Primary text | `text-neutral-100` |
| Body text | `text-neutral-300` |
| Secondary label | `text-neutral-400` |
| **Muted / metadata (the workhorse)** | `text-neutral-500` |
| Ghost / empty-state copy | `text-neutral-600` (+ `italic` for empties) |

`text-neutral-500` is the most-used class in Orquester's mature surfaces (26 hits across
`git/`, `command-palette/`, `sidebar/`). When in doubt for metadata, that is the answer.

### 3.3 Status colours

Use the semantic tokens. **Zero raw Tailwind hues** appear in Orquester's mature surfaces — no
`emerald-400`, no `sky-500`. The tokens are per-mode weighted so they stay ≥4.5:1 on a near-white
light surface.

| Meaning | Token | T3 equivalent |
|---|---|---|
| Act now (approval pending) | `warn` / `text-warn-300` | amber |
| In motion (working, connecting) | `info` / `text-info-300` | sky |
| Broken (failed, error) | `danger` / `text-danger-300` | red / destructive |
| Settled OK (completed, copied) | `ok` | emerald |
| Resting / idle | `text-neutral-500` — **no colour** | muted-foreground |

Wash + hairline pairs for banded surfaces are in `primitives/tone.ts` as `TONE_BAND` /
`TONE_BAND_TEXT`; the `-soft` steps are wash bases and are **always** used with an alpha modifier
(`bg-danger-soft/40`), exactly as the preset documents.

**The `<alpha-value>` rule.** Our preset emits `rgb(var(--n-800) / <alpha-value>)`. That is what
makes `bg-neutral-800/40` compile. If you write a raw `var(--n-800)` anywhere, every opacity
modifier on that property silently stops working.

### 3.4 Row-tone mapping (spec §7.3)

Failure styling is reserved. This table is behaviour, not taste:

| Condition | Icon | Colour |
|---|---|---|
| Normal tool row | tool icon | `text-neutral-500` |
| Non-zero command exit | tool icon + trailing `X` | **muted** (`text-neutral-500`, mark at `/40`) |
| `runtime.warning` | `circle-alert` | `text-warn` + `font-medium` |
| `runtime.error` or `*.failed` | `circle-alert` | `text-danger` + `font-medium` |

*T3: `MessagesTimeline.tsx:4837-4843, 4880-4898`; `session-logic.ts:161-170` (`workEntrySignalsSevereFailure`)*

A failed grep is not a catastrophe. Painting every non-zero exit red trains the user to ignore red.

### 3.5 Two surfaces that do not theme

Per AGENTS.md, xterm keeps a static palette and CodeMirror swaps only on resolved *mode*. Chat code
blocks are highlighted by the CodeMirror/Lezer parsers (spec §7.3), so **code blocks follow the
mode, not the scheme** — expected, and not a bug to "fix".

---

## 4. Motion — the complete inventory

Everything here is in `packages/ui/src/styles/agent-chat.css`. Every entry has a reduced-motion
fallback that lands on a *legible static state*, never a frozen invisible frame.

### 4.1 Timing tokens

| Token | Value | Used for |
|---|---|---|
| `--ac-dur-instant` | 90ms | Button press |
| `--ac-dur-fast` | 150ms | Colour changes, hover, stack disclosure |
| `--ac-dur-base` | 200ms | Chevron rotation, disclosure height, opacity reveals |
| `--ac-dur-banner` | 220ms | Banner exit only |
| `--ac-live-period` | 2.2s | Shimmer, rail sweep |
| `--ac-pulse-period` | 2s | Status pulse, ping |

*T3 sources: `duration-150` and `duration-200` throughout `MessagesTimeline.tsx` (`:1469, 2205,
2779, 3329`); `DISMISS_TRANSITION_MS = 220` at `ComposerBannerStack.tsx:10`; `2.2s` at
`index.css:456, 515`; `2s` at `index.css:151-152`.*

Easings: `--ac-ease-out` `cubic-bezier(0.16,1,0.3,1)` (arrivals), `--ac-ease-in`
`cubic-bezier(0.4,0,1,1)` (departures), `--ac-ease-standard` `cubic-bezier(0.4,0,0.2,1)`.

### 4.2 The inventory

| Utility | Keyframe / transition | Duration · easing · iteration | Trigger | Reduced motion |
|---|---|---|---|---|
| `ac-shimmer` | `ac-shimmer` — bright band travels a text-clipped gradient | 2.2s · `steps(30)` · infinite | A label describing something running **now** | `animation:none`, solid `text-neutral-300` |
| `ac-shimmer-settled` | none | — | The same label, settled | n/a (static) |
| `ac-dot-pulse` | `ac-status-pulse` — opacity 1 → .5, held | 2s · `steps(6)` · infinite | In-motion status dot | `animation:none`, `opacity:1` |
| `ac-dot-ping` | `ac-status-ping` — scale .75 → 2, opacity .9 → 0 | 2s · `steps(8)` · infinite | Act-now dot (approval waiting) | `display:none` (its resting frame is invisible) |
| `ac-skeleton` | `ac-skeleton` — opacity 1 → .55, held | 2.4s · `steps(4)` · infinite | Loading placeholder **container** | `animation:none`, `opacity:.75` |
| `ac-sweep` | `ac-sweep` — `translateX(0 → 100%)` under a mask | 2.2s · linear · infinite | Travelling focus band behind a live row | `animation:none`, `opacity:0` |
| `ac-sweep-counter` | `ac-sweep-counter` — `translateX(0 → -100%)` | 2.2s · linear · infinite | Holds content still while the band moves | `animation:none` |
| `ac-working-bar` | `ac-sweep` at 40% width, alternating | 1.76s · standard · infinite alternate | Indeterminate turn-progress hairline | full-width at `opacity:.4` |
| `ac-spin` | `ac-spin` — rotate 360° | 1s · linear · infinite | A control's own request in flight | slows to 2.4s |
| `ac-enter` | `ac-row-enter` — opacity + 2px rise | 200ms · ease-out · once (`both`) | A row just arrived | `animation:none` |
| `ac-banner-enter` | `ac-banner-in` — opacity + 4px rise | 150ms · ease-out · once | Banner docks | `animation:none` |
| `ac-banner-exit` | `ac-banner-out` — opacity + **64px fall** | 220ms · ease-in · once | Banner answered/dismissed | `display:none` |
| `ac-stack` / `ac-stack-items` | `grid-template-rows 0fr → 1fr`, + 4px fade | 150ms · ease-out | Banner stack expands | `transition:none` |
| `ac-disclosure` | `grid-template-rows 0fr → 1fr` | 200ms · standard | Any expand/collapse | `transition:none` |
| `ac-chevron` | `transform: rotate(90deg)` | 200ms · standard | Disclosure open state | `transition:none` |
| `ac-attention` | `ac-attention-ring` — 2px info ring | 650ms · ease-in-out · **2 iterations** | Row navigated to | static ring instead |
| `ac-countdown` | `ac-countdown` — `scaleX(1 → 0)` | caller-set · linear · once | Question auto-advance, toast dwell | jumps to `scaleX(0)` |
| `ac-press` | `transform: scale(0.97)` on `:active` | 90ms · standard | Any click | transform dropped, colours kept |
| `ac-reveal` | `opacity 0 → 1` | 200ms · standard | Row hover / focus-within | `transition:none`; always visible on coarse pointer |
| `ac-stream[data-streaming] > *` | `opacity` via `@starting-style` | 600ms · ease-out · once per block | A streamed markdown block first mounts | whole rule is inside `(prefers-reduced-motion: no-preference)` |

### 4.3 The three that carry the feel

**Shimmer.** The single most recognisable T3 motion. A band of light travels *across the text
itself* (`background-clip: text`), not a box behind it. Used for exactly one meaning: *this label
describes something happening right now*.
*T3: `index.css:432-459`; applied at `MessagesTimeline.tsx:3224` — `active && "live-tool-shine"`*

Never shimmer settled text. A shimmer on a finished summary makes the whole timeline look busy and
destroys the signal.

**Banner asymmetry.** A banner *rises* 4px in over 150ms and *falls* **64px** out over 220ms,
behind the composer. The asymmetry is the whole effect: the long fall says "that went away, and it
went *there*". A short symmetric fade reads as a glitch.
*T3: `ComposerBannerStack.tsx:210-215` (enter), `:125-130` (front exit, `translate-y-16`),
`:220-225` (a stacked item travels `translate-y-28`)*

**The streaming fade.** Each markdown block fades in over 600ms as it arrives — and only while
`data-streaming` is set, so re-opening a settled thread never replays a page of fades.
`@starting-style` fires only on first insertion. Opacity only: a transform here fights the
follow-scroll.
*T3: `index.css:1894-1908`*

### 4.4 What T3 deliberately does *not* animate

Knowing the negative space matters as much as the inventory:

- **No spinner on the working row.** The shimmer is the motion. A spinner is reserved for a control
  whose own request is in flight. *T3: `MessagesTimeline.tsx:2528-2536` has no spinner*
- **No transition on the timestamp reveal.** It swaps `absolute → static` on hover, with no
  transition, precisely so it cannot overlap the text mid-fade.
  *T3: `MessagesTimeline.tsx:2321-2323`*
- **No animation on the banner's toggle chevron.** `rotate-180` applied with no transition.
  *T3: `ComposerBanner.tsx:325-338`*
- **No `animate-pulse` in production.** Tailwind's built-in sine pulse appears only in a test file.
  Our `ac-dot-pulse` replaces it; note Orquester's existing `SessionStatusDot` still uses
  `animate-pulse` — that is pre-existing and out of scope here, but do not copy it into chat.
- **No gradient animation** on the "ultrathink" composer frame — the spectrum is static.

### 4.5 Reduced motion

T3 checks `prefers-reduced-motion` in **19 places**. Ours is centralised: every `ac-*` utility
carries its own `@media (prefers-reduced-motion: reduce)` block, and `useVisibleAnimation()` also
pauses on the media query. You should not need to write `motion-reduce:` by hand — if you do, it
means the motion is not coming from an `ac-*` class and probably should be.

The rule when writing a fallback: **land on a legible static state.** `ac-dot-ping` hides itself
(its resting frame is an invisible 2×-scaled ghost); `ac-sweep` goes to `opacity:0` (frozen, it is a
smudge); `ac-shimmer` restores a solid colour (frozen, its text is `transparent` — invisible).
Blindly writing `animation: none` on a shimmer makes the label disappear.

### 4.6 A note on `content-visibility`

T3 uses no `content-visibility` in the timeline — it virtualises with LegendList instead
(`recycleItems` deliberately **off** on the main list). Per spec §7.3 we start with a plain scroll
container, so `ac-rows` gives the browser the equivalent hint:
`content-visibility: auto; contain-intrinsic-size: auto 2.5rem` on the row elements (not the
scroller). This is the same idiom Orquester's sidebar already uses
(`Sidebar.tsx:1591`).

---

## 5. Per-component specs

### 5.1 User message

```
outer:  group flex flex-col items-end gap-1
bubble: relative max-w-[80%] rounded-2xl bg-neutral-800 p-3 text-neutral-100
meta:   flex w-full max-w-[80%] items-center justify-end pe-1 text-xs ac-tabular ac-reveal
```
*T3: `MessagesTimeline.tsx:2091-2092, 2205`*

Right-aligned, capped at **80%** width, no border. It is the only filled bubble in the timeline —
that alone distinguishes "you said" from "the agent said", with no avatars and no name labels.

An author heading exists but is `sr-only` (`:1931`) — screen readers get structure, sighted users
get alignment.

**Collapsing.** Over 8 lines / 600 characters the body clamps to `max-h-44` with a mask fade over
the last `1.75rem`, plus a "Show full message" toggle.
*T3: `MessagesTimeline.tsx:3984-3987, 4016-4028, 4054`*

**States:** meta strip (timestamp, copy, rewind) is `ac-reveal` — hidden until row hover or
focus-within, always visible on coarse pointers.

### 5.2 Assistant text

```
row: relative min-w-0 px-1 py-0.5
```
*T3: `MessagesTimeline.tsx:2366`*

No bubble, no background, full column width. The asymmetry with the user bubble *is* the
conversation design: the agent's output is the page, the user's input is an insert.

Markdown per §5.9. Wrap the markdown container in `ac-stream` and set `data-streaming` while the
message streams.

### 5.3 Activity group

The compressed representation of everything the agent did between two assistant messages, and the
densest thing in the UI.

```
header: flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left
        focus-visible:ring-1 focus-visible:ring-neutral-500
body:   mt-2            (children carry their own ms-7)
```
*T3: `MessagesTimeline.tsx:2661-2678`*

**The whole header row is the toggle, and it carries no chevron** — `aria-expanded` only. This is a
real departure from generic disclosure UI and it is what keeps the collapsed timeline calm. Use
`DisclosurePanel` (not `Disclosure`) so you own the header.

**Label states:**

| State | Content | Rendering |
|---|---|---|
| Live | the running tool's label, or `Thinking` | `<ShimmerText live>` |
| Settled | `summarizeToolGroup()` — "Read 3 files, ran 2 commands" | `<ShimmerText>` (settled class) |
| Settled, reasoning only | `Thought` / `Thought (×3)` | same |

*T3: `MessagesTimeline.tsx:2613-2622`*

**Live row anatomy** (`LiveActivityRow`, `:3158-3226`):

```
container: relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed
content:   flex min-h-6 min-w-0 items-center gap-1.5 py-0.5 px-0.5
icon slot: flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500
icon:      size={16} strokeWidth={1.8}
label:     min-w-0 flex-1 truncate   (+ ac-shimmer while live)
```

`w-fit` matters: the hover/focus background hugs the text instead of spanning the column.

### 5.4 Tool row

```
row:    group/timeline-row relative flex flex-col rounded-md px-0.5 py-0.5 transition-colors
        [expandable:] cursor-pointer hover:bg-neutral-800/40 focus-visible:ring-1 …
header: flex select-none items-center gap-1.5
label:  min-w-0 flex-1 truncate | expanded → whitespace-pre-wrap break-words select-text
panel:  mt-1 ms-7 rounded-md bg-neutral-900/60 px-3 py-2
output: max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono
        text-[11px] leading-relaxed select-text ac-scroll-thin
```
*T3: `MessagesTimeline.tsx:4920-4927, 4930, 4946-4951, 5017`, `:4546-4547`*

**Collapsed truncates; expanded wraps and becomes selectable.** `select-text` on the expanded body
is deliberate — the row is a button, and without it a drag to select output starts a toggle instead.

Icon and heading colour follow §3.4. Chevron: `DisclosureChevron`, `invisible` (not absent) when the
row cannot expand, so labels stay aligned down the column.

Timestamp: `ac-reveal`-like, but note T3's version swaps `absolute → static` on hover with **no
transition**, so a hidden timestamp occupies no layout and cannot overlap text mid-fade.
*T3: `MessagesTimeline.tsx:2321-2323`*

### 5.5 Working row

```
wrapper: border-b border-neutral-800 pb-2 pt-1
line:    flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed ac-tabular
label:   one <span>, text swapped in place, ac-shimmer while live
```
*T3: `MessagesTimeline.tsx:2528-2536`*

Use `WorkingIndicator`. **One element, label replaced** — the comment in T3 is explicit that the
setup→working handoff must "swap text in place instead of remounting the row". Remounting restarts
the shimmer and re-measures the line, so the handoff visibly stutters.

The bottom hairline is the only one in the timeline besides the turn fold: it reads as "everything
above this is done".

`WorkingTimer` self-ticks. Use `ElapsedTicker`, never a `setState` timer.

### 5.6 Compaction separator

```
role="separator"  mx-auto flex w-full max-w-3xl items-center gap-3 py-1 text-neutral-500 text-xs
rules:  h-px flex-1 bg-neutral-800   (one each side)
centre: flex shrink-0 items-center gap-1.5  +  <Minimize2 size={12} />
```
*T3: `MessagesTimeline.tsx:1866-1876`* — or use `ac-hairline`, which draws the rules as
pseudo-elements.

Per spec §7.3 our label carries before/after token counts, formatted client-side.

### 5.7 Queued ghost bubble

```
outer:  flex flex-col items-end
bubble: max-w-[80%] rounded-2xl border border-dashed border-neutral-700 p-3 text-neutral-300
actions: mt-2 flex items-center gap-4 text-neutral-500 text-xs
chip:   inline-flex h-6 items-center gap-1 + <Clock size={14} /> + "Queued"
buttons: ChatIconButton size="micro" → ArrowUp (send now), X (return to composer)
```
*T3: `MessagesTimeline.tsx:1778-1852`*

**Dashed and unfilled** against the user bubble's solid fill — "this is not sent yet" without a
word. The clock chip's tooltip names *when* it will go: "Sends after the next tool call or when the
turn ends" / "Sends after the messages above it" / "Waits for Send now" (`:1772-1777`).

> Queueing that is invisible is alarming; queueing that names its own trigger is not.

### 5.8 Changed-files card

```
card:   mt-4 rounded-lg bg-neutral-900
header: sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg
        bg-neutral-900 px-3 py-2
body:   p-2
dir/file row: group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left
              transition-colors hover:bg-neutral-800/60
              style={{ paddingLeft: 8 + depth * 14 }}
name:   truncate font-mono text-xs text-neutral-300
stat:   ml-auto shrink-0 font-mono text-[10px] ac-tabular
```
*T3: `ChangedFilesTree.tsx:51-56, 183, 192-212, 249-253`*

`sticky top-2` on the header is the nice touch — scroll a long file list and the summary stays.

Stat colours are the diff tokens, which in our system are the `--diff-add-fg` / `--diff-del-fg`
variables (`globals.css:42-45`) — consumed as `text-[color:var(--diff-add-fg)]`, matching
`git/DiffView.tsx`.

### 5.9 Markdown

T3 hand-rolls every element under a single `.chat-markdown` scope. The values worth copying:

| Element | Value | Cite |
|---|---|---|
| Root | `text-sm leading-relaxed` + `[overflow-wrap:anywhere]` | `ChatMarkdown.tsx:3334-3344` |
| Block spacing | `margin: 0.65rem 0` for p / ul / ol / blockquote / pre / table | `index.css:1668-1675` |
| First/last child | margin zeroed | `index.css:1660-1666` |
| Headings | `margin: 1.25rem 0 0.5rem`, weight 600, `line-height: 1.3` | `index.css:1677-1687` |
| h1…h6 | 1.25 / 1.125 / 1 / 0.875rem (h4–h6 share) | `index.css:1689-1705` |
| List indent | `padding-left: 1.25rem`; `li + li` → `margin-top: 0.25rem` | `index.css:1711-1753` |
| Ordered markers | `font-variant-numeric: tabular-nums` | `index.css:1731-1733` |
| Inline code | 1px border, `radius .375rem`, `padding .1rem .35rem`, **0.75rem** | `index.css:1818-1825` |
| Code block | `radius .75rem`, `padding .8rem .9rem`, thin scrollbar | `index.css:1838-1847` |
| Blockquote | `border-left: 2px`, `padding-left: .8rem`, muted | `index.css:1784-1788` |
| Table | `font-size: .75rem`, cells `.45rem .75rem`, **row separators only, no zebra** | `index.css:1915-1939` |
| Table cells (collapsed) | `max-width: 24rem`, truncate; expandable | `index.css:1943-1954` |
| Links | info-coloured, no underline; hover draws a **dotted** underline via a radial gradient | `index.css:1771-1782` |

Two details worth keeping: heading sizes barely exceed body text (an h1 is 20px in a 14px document —
chat headings are structure, not billboards), and the dotted hover underline is a genuinely nice
touch that costs one gradient.

Code-block chrome: header `pt-1.5 pr-1.5 pb-0 pl-3` with an 11px mono language label and a 24px
action cluster; copy feedback **1200ms**; copy button always visible (no hover-reveal on code
chrome). *T3: `ChatMarkdown.tsx:975-1021, 944-951`*

### 5.10 Banner / approval / question

Anatomy (our `BannerCard`):

```
grid-cols-[1.5rem_minmax(0,1fr)_auto]   icon | content | actions
```

| Density | Padding | Use |
|---|---|---|
| `compact` | `px-2 py-1` | Ambient notice |
| `default` | `px-2.5 py-1.5` | Most things |
| `spacious` | `px-3 py-3` | **Approvals and questions only** |

*T3: `ComposerBanner.tsx:164-166`; `ChatComposer.tsx:6150-6155` picks `spacious` exactly for approvals.*

Density is not decoration — it says how much attention the card is entitled to.

**Stack order** is fixed: activity first, then urgent/error/warning, then notices.
*T3: `ComposerBannerStack.tsx:33-41`*

**Approval card:**

```
header: flex w-full min-w-0 items-center gap-2 text-[11px] text-neutral-500
kind:   shrink-0 font-medium text-warn
counter: ml-auto shrink-0 ac-tabular        ("1/3", only when >1)
detail: block max-h-20 w-full overflow-auto text-xs whitespace-pre font-mono
        ac-scroll-thin tabIndex={0} focus-visible:ring-1 focus-visible:ring-neutral-500
```
*T3: `ComposerPendingApprovalPanel.tsx:39-63`*

The detail block is **80px tall, scrollable and keyboard-focusable** — a long command can be read
without leaving the banner. `tabIndex={0}` is what makes it reachable; do not drop it. An
`mcp-elicitation` renders prose (`whitespace-pre-wrap font-sans`) instead of mono.

Approve/Decline are primary; everything else goes in an overflow menu. An option's `warning` string
becomes a 12px triangle icon + tooltip + `aria-description`. While a decision is in flight every
control is `disabled` — the shared button recipe supplies the dimming.
*T3: `ComposerPendingApprovalActions.tsx:23-28, 36-41, 47-68`*

**Question card:**

```
option row: group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left
            transition-colors duration-150 focus-visible:ring-1
  selected:  bg-neutral-800/60 text-neutral-100
  idle:      bg-transparent text-neutral-300 hover:bg-neutral-800/40
  responding: opacity-50 cursor-not-allowed
digit badge: <Kbd variant="plain">   (20px, 10px text, no cap)
check:      <Check size={14} className="text-info" />
```
*T3: `ComposerPendingUserInputPanel.tsx:247-272`*

The digit badges are deliberately **bare** — nine outlined caps would out-shout the options they
label. Single-select auto-advances after **200ms** (`:129-132`); pair that with `ac-countdown` if you
show progress. Digit shortcuts are suppressed while collapsed (`:141-166`) — the numbers they refer
to are off screen.

### 5.11 Roster row

Geometry in §1.6. Content:

| Slot | Recipe |
|---|---|
| Dot | `<StatusDot size="xs" />` — 6px, static unless in-motion |
| Title | `min-w-0 truncate text-sm font-medium` |
| Role chip | `max-w-28 shrink-0 truncate rounded border border-neutral-800 px-1 font-mono text-[10px] text-neutral-500` |
| Elapsed | `min-w-14 text-right font-mono text-[11px] text-neutral-500` + `<ElapsedTicker>` |
| Activity | `truncate text-xs` — `text-danger` when failed, else `text-neutral-500` |
| Metrics | `truncate font-mono text-[11px] ac-tabular text-neutral-500` |

*T3: `AgentsPanel.tsx:159-189`*

**Activity text order flips with status** — live rows lead with what is happening, settled rows lead
with the outcome:

```
live:    progress ?? "▸ " + lastToolName ?? result ?? error
settled: error ?? result ?? progress ?? "▸ " + lastToolName
```
*T3: `AgentsPanel.tsx:120-137`* — the `▸ ` prefix (U+25B8 + space) marks a tool name.

Status → tone, per Law 4: `pending|running|waiting` → `info` (pulse); `idle` → **`muted`**;
`completed` → `ok`; `failed` → `danger`; `cancelled|interrupted` → `muted`.

The role chip is suppressed when it case-folds equal to the title (`:146-149`) — no "Reviewer ·
reviewer".

### 5.12 Context meter

Use `MeterRing`. Geometry: `viewBox 0 0 24`, `r=9.75`, `strokeWidth=3`, rotated -90°,
`strokeLinecap="round"`, `strokeDasharray = 2πr ≈ 61.26`, `strokeDashoffset = C·(1 − pct/100)`.
Transition `stroke-dashoffset, stroke` over **500ms ease-out**, `motion-reduce:transition-none`.
*T3: `ContextWindowMeter.tsx:26-80`*

500ms is deliberately the slowest motion in the surface: values arrive in jumps, and a slow sweep
reads as a measurement settling rather than a number flickering.

Over **90%** the arc turns `danger` — the one place a colour change is a *threshold*, so it must be
abrupt. `isMeterOverloaded` is exclusive: 90.0 is still normal.

**Without `maxTokens` there is no ring and no percentage** (spec §7.6) — an adapter with
`reportsContextWindow: false` degrades to a bare token count. `formatMeterPercent(null)` returns
`null` for exactly this reason; never substitute `0%`.

### 5.13 Scroll-to-end pill

Use `ScrollToBottomButton`. Centred, `rounded-full`, 24px tall, muted until hover, floating
`bottom = composerHeight + 4`. `pointer-events-none` on the positioning wrapper and `auto` on the
button, so the invisible band around it never eats a click. `onPointerDown → preventDefault()` keeps
the composer's caret where it is.
*T3: `ChatView.tsx:9964-9982`*

It exists for one situation: the user scrolled up while a turn streams, disarming live-follow. It is
the single affordance that re-arms every follow flag — nothing else should scroll the user back.

### 5.14 Focus

The house recipe, 17 sites in Orquester:

```
focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500
```

Inside a dense row add `focus-visible:ring-inset` so the ring does not overlap the neighbour above.
There is no `ring-offset-*` anywhere in this codebase — do not introduce one.

---

## 6. Do / don't — the ten things most likely to make this feel un-T3

1. **Don't use `animate-pulse` or `animate-spin` for status.** Tailwind's sine-wave pulse repaints
   every vsync; a chat view with a dozen live indicators on a 120Hz display will visibly heat the
   machine. **Do** use `ac-dot-pulse` / `ac-spin`, which are duty-cycled and pause off-screen.

2. **Don't remount a row to change its label.** It restarts the shimmer and re-measures the line, so
   the starting→working→tool-name progression stutters. **Do** swap `textContent` inside one stable
   element — that is what `ShimmerText` and `WorkingIndicator` exist for.
   *T3: `MessagesTimeline.tsx:2528-2536`*

3. **Don't tick a timer through React state.** Twenty live roster rows become twenty renders a
   second, each re-running its parent's memo chain. **Do** use `ElapsedTicker` (DOM write, zero
   commits). *T3: `AgentsPanel.tsx:82-113`*

4. **Don't let a number change a row's width.** **Do** put `ac-tabular` on every elapsed time, token
   count, percentage and `1/N`. Without it a ticking counter twitches the row once a second, which
   is the loudest possible way to look unfinished.

5. **Don't colour an idle agent as live.** T3 shipped a sky idle dot and users read it as stuck.
   **Do** give idle-but-resumable the muted tone; keep colour for act-now, in-motion and broken
   only. *T3: `AgentsPanel.tsx:42-43`*

6. **Don't paint every failure red.** A non-zero command exit is a muted mark; only `runtime.error`
   or a `*.failed` lifecycle gets destructive styling, and `runtime.warning` gets its own warning
   colour. Red everywhere trains the user to ignore red.
   *T3: `MessagesTimeline.tsx:4837-4843`*

7. **Don't animate a pixel height for streaming content.** A measured height clips new lines until
   something re-measures, and nested collapsibles restart their parent's transition every frame.
   **Do** use `ac-disclosure` (`grid-template-rows: 0fr → 1fr`), which nests for free and keeps
   sizing to `auto`. *T3 hit exactly this: `index.css:615-626`*

8. **Don't make the composer a flex child.** It must be an overlay publishing its height as the
   list's bottom inset, or every composer growth pushes the messages the user is reading. **Do**
   republish the height on resize, and exclude footer layout from follow-scroll triggers.
   *T3: `ChatView.tsx:9988-9996, 5900-5917`*

9. **Don't give a banner a symmetric fade, a bottom border, or full composer width.** T3's banner is
   a drawer: inset 22px each side, overlapping 17px, square-bottomed, rising 4px in and falling
   **64px** out. Those three details are most of why the dock feels attached rather than stacked.
   *T3: `ComposerBanner.tsx:55, 111`; `ComposerBannerStack.tsx:125-130`*

10. **Don't hard-code a colour, and don't drop the `<alpha-value>`.** No `bg-zinc-900`, no
    `text-emerald-400`, no raw `var(--n-800)` in a colour property. **Do** go through the neutral
    steps and the `danger`/`warn`/`ok`/`info` tokens, and remember the scale is perceptual: `--n-50`
    is the strongest foreground in **both** light and dark. A literal breaks six of seven schemes,
    and a raw `var()` silently kills every opacity modifier on that property.

**Bonus, because it is the most common review comment:** don't shimmer settled text, don't spin
while merely thinking, and don't put an interactive decision in a timeline row — approvals live in
the docked banner, always (spec §7.3).

---

## 7. Quick reference

### CSS utilities (`packages/ui/src/styles/agent-chat.css`)

**Live indicators:** `ac-shimmer` · `ac-shimmer-settled` · `ac-dot` · `ac-dot-pulse` ·
`ac-dot-ping` · `ac-sweep` · `ac-sweep-counter` · `ac-sweep-aligned` · `ac-working-bar` ·
`ac-spin` · `ac-skeleton`

**One-shot:** `ac-enter` · `ac-banner-enter` · `ac-banner-exit` · `ac-stream` · `ac-attention` ·
`ac-countdown`

**Disclosure:** `ac-disclosure` · `ac-disclosure-panel` · `ac-chevron` · `ac-stack` ·
`ac-stack-panel` · `ac-stack-items`

**Interaction:** `ac-press` · `ac-reveal`

**Surface / text:** `ac-tabular` · `ac-rows` · `ac-scroll-thin` · `ac-fade-top` · `ac-hairline`

**Escape hatch:** `ac-no-motion`

**Keyframes:** `ac-shimmer` · `ac-status-pulse` · `ac-status-ping` · `ac-skeleton` · `ac-sweep` ·
`ac-sweep-counter` · `ac-row-enter` · `ac-banner-in` · `ac-banner-out` · `ac-attention-ring` ·
`ac-countdown` · `ac-spin`

**Variables:** `--ac-anim-state` · `--ac-anim-will-change` · `--ac-live-period` ·
`--ac-pulse-period` · `--ac-dur-instant|fast|base|slow|banner` · `--ac-ease-out|in|standard` ·
`--ac-sweep-width`

### Primitives (`packages/ui/src/components/agent-chat/primitives`)

| Export | Kind |
|---|---|
| `ShimmerText` | Live label; swap `live` without remounting |
| `StatusDot` | Tone + `pulse` / `ping`; sizes `xs`/`sm`/`md` |
| `WorkingIndicator` | The "turn is alive" row |
| `Disclosure`, `DisclosurePanel`, `DisclosureChevron` | Height-safe expand/collapse |
| `Kbd` | Shortcut hint; `cap` / `plain` variants |
| `MeterRing` | Context ring with the >90% threshold |
| `ElapsedTicker` | DOM-write timer, zero React commits |
| `BannerCard` | Docked banner chrome; 5 variants × 3 densities |
| `ChatIconButton` | 20 / 24 / 28px icon button |
| `CopyButton` | Copy → Check, 1200ms |
| `ScrollToBottomButton` | The follow-re-arm pill |
| `useVisibleAnimation`, `observeVisibleAnimation` | The off-screen pause gate |
| `TONE_TEXT`, `TONE_FILL`, `TONE_BAND`, `TONE_BAND_TEXT`, `ChatTone` | The tone tables |
| `formatElapsed`, `elapsedBetween` | Elapsed formatting (tested) |
| `clampMeterPercent`, `isMeterOverloaded`, `meterDashOffset`, `formatMeterPercent`, `METER_OVERLOAD_PERCENT` | Meter math (tested) |
| `shortcutKeys`, `isAppleLike` | Shortcut glyphs (tested) |
| `COPY_FEEDBACK_MS` | 1200 |
