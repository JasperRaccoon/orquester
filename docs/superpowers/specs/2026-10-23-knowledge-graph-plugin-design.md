# Knowledge Graph plugin: a shared, searchable knowledge base for agents, built with myKG

Status: draft, awaiting approval.

## Intent

The user follows creators on X who post useful material about running SaaS
products, building and publishing mobile apps, SEO, getting cited by AI
search engines, and running ads. Today they paste the posts they want to keep
into plain text files, one file covering several topics. The sample file
(`…/attachments/…faa4877c….txt`, about 36 KB) shows what that looks like:

- The posts are raw copies from the X web UI, still carrying page chrome
  ("Post", "Ver posts nuevos", "Conversación", "Copy").
- Some posts have a handle and a date, and almost none have a URL.
- The content varies: short single posts, numbered threads, a long article
  with tables and JSON, and the user's own notes between `-------------`
  separators.

None of that is reachable by their agents. The plugin turns these saved posts
and notes into a knowledge base that agents in Orquester chats use:

1. **On their own**, while working. A chat building a landing page checks
   the SEO knowledge before deciding, without the user asking, and uses it
   without announcing it.
2. **When asked.** "How can we improve the general SEO of the page?" is
   answered from the saved knowledge, citing the entries it drew on, rather
   than from general training knowledge.

Adding material stays as low-effort as today: the user pastes a raw post into
any chat and says "add this to the knowledge". The agent cleans it up and
decides which collections it belongs in.

The knowledge is split into **collections** (for example SEO, AI search, Ads,
SaaS, Mobile apps). **Agent Profiles** choose which collections their chats
see, so a "Mobile app developer expert" profile is not cluttered with SaaS
billing material. A Global chat (no profile) sees everything.

The graph part comes from [myKG](https://github.com/SenolIsci/mykg) (MIT,
Python). It extracts concepts and relationships from documents with an LLM,
so entries get linked to each other: for example, an "alternatives pages"
post connects to another creator's "[competitor] vs [you]" advice. The
indexing runs on the user's Claude subscription, through Orquester's accounts.

It is an optional, built-in plugin in Settings → Plugins called **Knowledge
Graph**, off by default. It follows the Better TS Typecheck pattern: it
downloads a third-party tool, shows its version, and checks for updates.

## Terms

- **Entry:** one saved item. It can be a post, a thread, an article, a case
  study or the user's own note. It is deliberately not called a "tip",
  because not everything saved is advice (user decision).
- **Collection:** a named topic label with a one-line description. An entry
  carries one or more collections.
- **Concept:** a node myKG extracts from entries (a tactic, tool, company,
  platform, metric, and so on). The graph is made of concepts and the
  relationships between them. Each concept knows which entries it came from.
- **Linking:** the background myKG run that extracts concepts from new or
  changed entries and merges them into the graph.

## Goals (user decisions unless marked)

1. **Agents pull knowledge in themselves.** In any chat that can see at least
   one collection, the agent knows which collections exist and what they
   cover without spending a tool call to find out. It searches them when its
   task touches those topics. When it uses knowledge unprompted it does not
   announce it. When the user asks a question directly, the answer cites the
   entries used.
2. **Visibility follows the chat's profile.** A chat with a profile sees only
   the collections ticked in that profile. A chat with no profile (Global)
   sees every collection. This is a filter against clutter, not a
   confidentiality boundary: the user's reason was "so they don't get
   cluttered". A profile chat never gets hidden entries in its results, nor
   concepts or links that exist only because of hidden entries. Two leaks are
   acceptable: a shared concept's description or aliases may carry wording
   that myKG merged from a hidden entry, and a duplicate reply may name a
   hidden entry.
3. **Saving from chat.** The user pastes raw material and asks the agent to
   save it. The agent decides which collections fit, whether one, several or
   all of them. Collection choice is based on content, not on the chat's
   profile: an ads post pasted into a SaaS chat goes to Ads. A profile chat
   can save into collections it cannot see.
4. **A Knowledge tab the user can look at.** It opens on an interactive graph,
   with a toggle to a list view. Details are under "Knowledge tab" below.
5. **Search by meaning.** "Ranking in ChatGPT" must find the Cloudflare
   case study even though it never uses those words. myKG only has keyword
   (BM25) search, so the plugin adds local embeddings. This is the user's
   "vectorized knowledge graph".
6. **One knowledge base per server**, not per project, because the same SEO
   knowledge helps every app the user builds *(my call)*.
7. **Import of existing notes.** The user's existing notes files can be
   imported through an agent chat, split into entries the same way as a
   paste.
8. **It must be fast, use few tokens without losing quality, and be
   correct.** The user named these three as the things that would make it a
   failure if missed.

## The three bars, made concrete

These are my targets. The builder should keep them and measure them.

**Fast**
- Saving returns to the chat within about 2 s. Saving writes the entry and its
  embedding and makes it searchable. It never waits for linking.
- Search returns within about 300 ms p95 at 5,000 entries.
- Linking one new entry finishes within a couple of minutes.
- Linking runs in parallel, with a concurrency setting that defaults to 4.

**Light on tokens without losing quality**
- Indexing runs as real Claude Code agent chats, kept as lean as a Claude
  Code session can be (see "Indexing on the subscription"):
  - A dedicated minimal profile, so no skills, MCP servers, hooks or
    CLAUDE.md are loaded.
  - Many extraction tasks per session, so the session's fixed prompt is paid
    once per batch rather than once per call, and stays prompt-cached.
  - A step's instructions (which include the schema) are sent once per
    session, not once per task.
  - Each session is retired before its context grows large.
- Saves made close together are combined into one linking run. A run starts
  20 s after the last save, and never more than 2 minutes after the first
  pending save *(my call; tune freely)*.
- Changing an entry's collections costs no LLM calls, because collections
  are Orquester metadata and not part of the graph.
- Agent search results are compact. The default is at most 8 hits, each with
  a title, author, collections and a one-to-two-line snippet. Full text
  costs a second, explicit call.
- Duplicates are caught at save time, by the same URL or near-identical text.
  A duplicate is not linked again. The tool reports "already saved as X" and
  adds any new collections to the existing entry.
- Quality is not traded away: the indexing model stays a strong model by
  default (Sonnet class), with a setting to change it.

**Correct**
- An entry keeps the author's words verbatim. Cleanup removes only site
  chrome (UI labels, "Copy" buttons, view counts, repeated "Post" headers);
  it never summarises or paraphrases. The agent may add a short descriptive
  title and the metadata it can see (author name, handle, date, URL, kind).
- Profile scoping is enforced on the daemon, inside search and traversal, and
  not by filtering results afterwards. A path through a hidden concept is not
  a path. The guarantee is at the level of entries, concepts and edges (see
  goal 2); attribute-level provenance is out of scope.
- Extraction prompts suit this content. myKG's shipped Pass 2 prompt is
  written for a corpus of WWII aircraft documents (its examples are aircraft
  variants and technical reports). The plugin ships its own prompts for
  posts, threads, articles and notes (see "Prompt overlay").
- Who said it reaches the graph. myKG's chunker strips YAML frontmatter, so
  the copy myKG reads carries the author, handle, kind and date as a plain
  header line. Authors become concepts, which is how "another creator's
  advice on the same thing" gets linked.
- Answers given on request cite entries as clickable citations that open them
  in the Knowledge tab (see "Citations").
- The graph's schema must not stay frozen on whatever the first handful of
  entries looked like (see "Schema growth").
- Indexing chats can't wander. They work only through two worker tools, with
  built-in tools disabled where the adapter allows it. Every answer is
  checked as valid JSON before myKG sees it, and an invalid one goes straight
  back to the same chat to be redone.

## Non-goals

- Pulling posts from X automatically (the X API, a browser extension, or
  scraping). Pasting stays the way in.
- myKG's Obsidian vault, Neo4j CSV, TTL, NetworkX exports and its own
  `knowledge_graph.html`. The plugin turns them off. myKG's HTML loads its
  graph library from a CDN, so it is not self-contained anyway.
- myKG's document preprocessing (MinerU for PDF, DOCX and images). That is a
  multi-GB runtime download. Entries are Markdown, so preprocessing is
  disabled.
- myKG's `/mykg` Claude Code skill and `mykg init`. Init writes into
  `~/.claude` and the project's CLAUDE.md, which conflicts with Agent
  Profiles. The daemon writes myKG's config itself.
- myKG's MCP server (`mykg mcp-serve`). See "Querying" for why.
- Separate knowledge bases per project or per workspace.
- Agents deleting or rewriting entries in v1. The user does that in the
  Knowledge tab.
- Tools on the external MCP endpoint in v1. Chat audience only *(my call)*.

## Anti-goals (would make it a failure even if it works)

- A save that makes the chat wait for the graph.
- Each indexing call paying for a full agent session's prompt, or each save
  rebuilding the whole graph with LLM calls.
- Entries filed in the wrong collections, or content reworded so details are
  lost.
- A profile chat seeing entries or links from collections it should not see.
- Agents answering "from the knowledge" with things that are not in it.

## Design

### Storage (my call)

Everything lives under a new `packages/config` path helper,
`<appdir>/daemon/plugins/knowledge-graph/`:

- `entries/<entryId>.md`: one Markdown file per entry. YAML frontmatter
  holds `id`, `title`, `kind`, `author`, `handle`, `url`, `postedAt`,
  `savedAt`, `savedFrom` (session ID), `collections: [ids]` and
  `contentHash`; the body is the verbatim text. This folder is myKG's input.
  A long article stays one entry; chunking for embeddings is the search
  layer's business.
- `collections.json`: `[{id, name, description, color}]`, a tolerant store
  that keeps unknown fields.
- `index/`: embeddings and the search index. This is a disposable cache that
  can be rebuilt from `entries/`.
- `mykg/`: myKG's working directory, holding three things:
  - The generated `mykg_config.yaml`.
  - `input/<entryId>.md`: what myKG reads. Each file is generated from the
    entry and has no frontmatter: one plain header line
    (`Author: Om Patel (@om_patel5) · Thread · 2026-10-11`), a title line,
    then the verbatim body. Collections are deliberately left out. myKG
    hashes whole files to detect changes, so relabelling an entry must not
    change its input file.
  - `mykg_sessions/<session>/`. myKG names sessions itself and
    `--session` only accepts an existing one. The first run creates the
    session, and its name, taken from the first stdout line
    `Session: <name>`, is recorded in `state.json`. The graph output
    (`nodes.jsonl`, `edges.jsonl`) is read from here.
- `state.json`: linking state (`pendingSince`, current run, last run result,
  token totals, last error). It is persisted before a run starts.
- `runtime/versions/<v>/`: the myKG install (see "Install and updates").

The entry files are the durable record. The graph, embeddings and indexes can
all be rebuilt from them.

One entry per file, with myKG's `batch_per_file: true`. myKG only removes
exactly one file's contribution when that file is deleted or edited if files
are batched this way. That makes edit and delete correct, at the cost of at
least one extraction call per entry. Pasted entries are small, so this is the
right trade.

### Collections and profiles

- Collections are created, renamed, described, recoloured and deleted in the
  Knowledge tab's list view. An agent's save may also create a collection,
  but only by passing an explicit name and description; the result tells the
  user it did so.
- Deleting a collection removes the label. Entries left with no collection
  show as "Unfiled", which only Global chats see *(my call)*.
- `SessionProfileSettings` gains `knowledgeCollections?: string[]` (collection
  IDs), persisted in `profile.json` and tolerated when missing. The Agent
  Profile editor gets a "Knowledge" section of checkboxes. The list view
  shows the same links from the other side ("SEO · SaaS expert, Mobile
  expert").
- What a chat sees:
  - no profile: every collection
  - a profile: only the collections ticked in it
  - a profile with none ticked: no search tools are advertised, but the save
    tool is
- Removing a profile-chat's collection takes effect on the next tool call.
  Nothing is cached in the chat.

### Agent tools

These are a new tool family in the Orquester catalog
(`apps/daemon/src/mcp/catalog/`), audience `chat`. They are advertised only
while the plugin is enabled, the same way the `boxes` toolset is gated. They
reach new daemon routes through `DaemonApi`, and every route resolves the
calling session's visible collections on the server.

- `knowledge_search(query, collections?, limit?)`: hybrid search over the
  visible collections (see "Querying"). It returns compact hits: an entry
  (ID, title, kind, author, collections, snippet, score) or a concept (name,
  type, and the IDs of its top entries). Read tier.
- `knowledge_get(id)`: one entry's full text and metadata, plus its linked
  concepts and the related visible entries (compact). Given a concept ID, it
  returns the concept's description and its visible entries. Read tier.
- `knowledge_save(entries[], newCollections?)`: saves one or many entries.
  Each item has the cleaned text, an optional title, kind, author, handle, URL
  and date, and `collections` (required, at least one). It returns each
  entry's ID, its collections, whether it was a duplicate, and "linking
  queued". Act tier, with no approval card, because saving must stay fast.
  Bulk import is a single call with many items.
- `knowledge_collections()`: every collection's name, description and entry
  count, for choosing where to save. Read tier.

Every entry in a tool result carries a ready-made citation (see "Citations"),
so the agent copies it rather than composing one.

Tool descriptions carry the cleanup rules: keep words verbatim, strip chrome
only, keep a thread as one entry, and split unrelated posts into separate
entries. They also carry the citation rule: on a direct question, cite entry
IDs.

For goal 1, a chat must already know its visible collections, plus a nudge
to search before deciding on those topics. The Orquester instruction block
has no room left for this: the fixed part is 1,951 bytes and the worst case
is about 2,043 of the 2,048-byte cap. Tool descriptions can't carry it
either, because they come from a static catalog shared by every chat.

So *(my call)* the per-thread manifest gains one optional knowledge line,
built by the daemon only for chats that can see at least one collection. It
lists collection names only, no descriptions, for example:
`Knowledge: SEO, AI search, Ads. Search it (knowledge_search) before
deciding on these topics.` The line is capped at 256 bytes, and the
instruction cap rises by exactly that amount only when the line is present.
The existing D-13 budget test is updated to cover both cases, and a chat
without knowledge pays nothing. Descriptions stay in
`knowledge_collections()` for saving.

The existing chat-tool byte budgets (`registry.test.ts`) apply.

### Querying (my call)

The daemon answers queries itself, in TypeScript, from myKG's output files.
It does not run `mykg mcp-serve`:

- Collection filtering has to happen inside traversal to be correct. myKG's
  server would let a path or neighbourhood run through hidden concepts, and
  filtering afterwards cannot undo that.
- One shared graph needs no Python process to stay alive.
- myKG's HTTP server has no auth and one global PID file. Its stdio server
  would need one child per graph and a manual `reload` after every run.

After each linking run the daemon loads `nodes.jsonl` and `edges.jsonl` into
memory, swapping atomically so in-flight queries see the old graph. Each
concept's `source_files[]` maps to entry IDs, and from there to collections.
A concept is visible if at least one of its source entries is visible. An
edge is visible if both ends are visible and at least one entry supporting
it is visible.

Search is hybrid:

1. Embedding similarity over entry chunks.
2. BM25 over entry text and concept names, aliases and attributes.
3. A one-hop expansion through visible concepts, to pull in strongly related
   entries.

Results are merged (reciprocal-rank fusion is fine) and capped. Entries are
searchable by steps 1 and 2 as soon as they are saved. Step 3 includes them
once linking finishes.

**Embeddings run locally**, on CPU, with no API key and no network at query
time. The model is a small one (bge-small or all-MiniLM class, roughly
30–130 MB), downloaded by the plugin installer with its hash checked.
Embeddings are cached per `contentHash`. The runtime (Node ONNX,
transformers.js, or a Python helper in the plugin's own runtime) is the
builder's call. A long-lived daemon-side Python process is not wanted.

### Indexing on the subscription (user decision: it stays Claude Code)

**Indexing runs as genuine Claude Code sessions.** Each LLM call myKG needs
is answered inside an ordinary Orquester agent chat, which runs the real
Claude Code CLI on one of the user's accounts. The user required this so the
subscription is only ever used through Claude Code, as Anthropic's terms
expect.

The plugin therefore must never:

- expose the subscription as a general API, through a proxy, a gateway or an
  OpenAI- or Anthropic-compatible endpoint;
- run single raw completions outside a Claude Code session;
- copy credentials out of account homes.

myKG supports this way of working natively. With its `agent-claude-code`
profile, each LLM call becomes a task file in
`intermediate/agent_inbox/<id>.task.json`, and the pipeline waits for
`agent_outbox/<id>.answer.json` plus a `.done` marker. Answered tasks are
cached, so a resumed run reuses them. The plugin keeps that protocol and
supplies the agents itself. It does not use myKG's `/mykg` skill or `mykg
init`.

**Worker sessions**
- The `KnowledgeService` starts unattended agent-chat sessions through
  `DaemonApi`, the same way the workflow Agent block does
  (`workflows/agent/create.ts`):
  - an explicit `accountId`
  - an `owner` that marks the session as the plugin's
  - `cwd` in the plugin's work directory, so no project files or CLAUDE.md
    load
  - the indexing model
- Sessions use a built-in, hidden, Orquester-managed Agent Profile, "Knowledge
  indexer". It has no skills, no MCP servers beyond Orquester's own, no
  hooks, built-in skills hidden, and a short instruction text.
- The session's work goes through two chat tools, advertised only to
  sessions the plugin owns:
  - `knowledge_worker_next_task()` returns the next pending task's
    instructions and input, or "done" when the run has no more. To save
    tokens it returns a step's instructions only the first time in each
    session, or when they change; after that it says "same instructions as
    task N".
  - `knowledge_worker_submit(taskId, answer)` checks that the answer parses
    as the JSON myKG expects, writes `.answer.json` atomically and then
    `.done`, and returns the next task in the same response, saving a round
    trip. An answer that does not parse is refused with the parse error, and
    the session redoes the task.
- Claude Code's built-in tools are disabled for these sessions where the
  adapter supports it (for example the SDK's allowed-tools list); otherwise
  the instruction text forbids them *(builder checks the adapter)*.
- A session handles tasks until its context passes a budget, by task count
  or token count *(builder's call, measured)*, then ends. The service starts
  a fresh one if tasks remain. This keeps the cost of each task flat instead
  of growing with the conversation.
- The concurrency setting (default 4) is the number of worker sessions
  running at once. myKG's `max_workers` is set high enough that enough tasks
  are always waiting in the inbox.
- Worker sessions are not shown in the sidebar. The plugin's Activity panel
  lists the current and recent ones, with a link to each transcript for
  debugging. Their usage appears under Usage like any chat.

**Accounts.** Sessions run on the account picked in plugin settings. On a
usage limit they fail over to the user's other Claude accounts, reusing the
Agent block's selection and failover logic (`workflows/agent/select.ts`,
`failover.ts`). If every account is limited, the run pauses and resumes once
a limit resets. It never fails silently, and the status bar says why. Codex
accounts could work the same way, since the mechanism is agent-agnostic,
but v1 offers Claude only *(my call)*.

**No usage cap or headroom rule (user decision).** Linking may use accounts
right up to their limits. In exchange, the user asked that every run be as
token-efficient as possible, so the measures under "Light on tokens" are
requirements, not tuning:

- batched, lean worker sessions with instructions sent once per session
- coalesced runs
- dedup at save time
- collection edits that cost no LLM calls
- one entry per myKG input file

The builder measures tokens per linked entry on the round-trip fixture and
treats a regression there as a failing test.

### Prompt overlay (my call)

myKG loads its prompts from text files inside the installed package
(`src/mykg/prompts/**.txt`, read by `prompts.py`), and nothing in its config
can replace them. Its Pass 2 system prompt is tuned for WWII aircraft
documents.

The plugin keeps its own versions of the Pass 1 and Pass 2 prompts, and of
any other step whose wording is domain-specific, under
`apps/daemon/src/knowledge/mykg-prompts/<pinned-version>/`. After install, the
installer copies them over the package's prompt files, inside the plugin's
private venv only. The smoke test checks that every overlaid file exists in
the installed package, so a myKG version that renames prompts fails the
install instead of extracting with mismatched prompts.

The prompts keep myKG's output contract (JSON shape, schema handling)
unchanged and change only the domain guidance:

- the expected input: social posts, threads, articles, personal notes
- the concept types worth extracting: tactics, tools and platforms,
  companies, metrics, people and creators, channels
- authors from the header line become Person concepts

Moving the pinned version means re-checking the overlay against the new
prompts. The recorded round-trip test covers this.

### Linking runs

- Runs are a single-flight queue owned by a daemon `KnowledgeService`,
  following the `PluginsService` serialized-job pattern. Saves during a run
  queue the next one.
- A run invokes `mykg extract-graph <input> --session <recorded> --update`
  (new and edited entries, deleted ones removed), with the generated config:
  - preprocessing off and every export off
  - orphan pass off
  - `batch_per_file: true`
  - profile `agent-claude-code`, with `max_workers` sized so the inbox stays
    stocked

  The very first run is a full extract, which does schema induction.
- The child runs with a minimal environment: `HOME` points into the plugin
  directory, so myKG writes nothing into the user's real home. No provider
  keys or account variables are set: myKG never calls an LLM itself.
- Progress comes from myKG's `pipeline_state.json` (per-step status; the
  top-level status is always "running") and `pass2_progress.json`. It is
  published on the broadcaster like box setup steps. A failed step's
  traceback is kept in `state.json` as `lastError`.
- If the daemon restarts mid-run, the next start reruns `--update`. myKG
  resumes from its finished steps, cached shards and answered tasks. Worker
  sessions survive in the agent host, and they simply pick up tasks again.
- Each run records tokens in and out, the call count and its duration, for
  the settings panel.
- *To verify before relying on it:* whether myKG's `normalize_names`
  reprocesses every name on `--update` or only new ones. If it is every name,
  the builder limits it, or flags the cost, before shipping.

### Schema growth

myKG induces its schema of concept and relationship types from the corpus on
the first run. A personal knowledge base grows into new topics, so the
schema must not stay frozen on the first handful of entries.

The default policy *(my call)*: normal runs use `--update`. When myKG's
`detect-schema-drift` reports meaningful drift, or a set number of new
entries have arrived since the last schema change, the next run uses
`--append-with-grow-schema`. The settings panel also has a "Rebuild graph"
action for a full re-extraction. Its confirmation shows the expected number
of calls, as information only.

The thresholds are the builder's call.

### Knowledge tab

This is a new tab type, like the Excalidraw whiteboard: a `ProjectTab` arm,
lazy-loaded, offered in the New tab → Tools menu only while the plugin is on.
It shows the server-wide knowledge base whichever project it is opened in.
The mockup the user picked is layout A, with B's list as a toggle.

**Graph view (default)**
- The top bar has a search box, which uses the same hybrid search, and
  collection filter chips.
- The canvas shows concepts, coloured by collection.
- Clicking a concept opens a side panel with:
  - its type and confidence
  - its description
  - the entries behind it, with author and a quote
  - the concepts it links to
- From an entry in the panel the user can open the original post (when there
  is a URL), edit the entry's text, edit its collections, or delete it.

**List view**
- Collections down the left, each with an entry count and the profiles that
  see it.
- "+ New collection", "Unfiled" and "All".
- Entry cards with title, author, date, collection chips and a link count.
  Selecting one opens the same entry panel.

**Status bar**
- Entry, concept and collection counts.
- Linking state: idle, queued, "linking N entries", or paused with the reason.

Editing an entry's text or deleting it queues a linking run. Changing its
collections takes effect immediately.

The graph library (Cytoscape, Sigma, or similar) is the builder's call. It
must be bundled, never loaded from a CDN, and handle a few thousand nodes.
Above that, the canvas shows the neighbourhood of the search or selection
rather than everything.

### Citations (user decision: clickable)

When an agent answers a question from the knowledge, each entry it used
appears in the answer as a clickable citation, for example a small chip with
the entry's title and author. Clicking one opens the Knowledge tab in the
current project, or focuses it if it is already open, with that entry
selected in its side panel.

- Tool results give each entry a citation token, and the descriptions tell
  the agent to paste it verbatim. The format is the builder's call: for
  example a Markdown link with a dedicated scheme
  (`[Alternatives pages · @hridoyreh](orquester-knowledge:entry/<id>)`).
  It must stay readable as plain text.
- The agent-chat GUI (`packages/ui`, so both desktop and web) renders the
  token as a chip and routes the click. It is never treated as an external
  link.
- A citation to an entry that has since been deleted renders as a struck-out
  chip saying "deleted".
- Terminal chats, and chats where the plugin is off, show the plain text.

### Settings → Plugins entry

- **Catalog:** `knowledge-graph`, "Knowledge Graph", provider Community,
  source `SenolIsci/mykg`, `updates: true`, glyph, and search keywords.
- **Status:** myKG version and install date, "Check for updates",
  "Remove downloads" (refused while the plugin is on), and the last error.
- **Settings:**
  - "Enable on this server"
  - indexing account: a picker over Claude accounts, defaulting to automatic
    with failover
  - indexing model
  - concurrency
- **Activity:** entries, last run (when, how long, calls, tokens), tokens
  used this week, and "Rebuild graph".

### Install and updates (my call)

The plugin installs into `runtime/` using the ts-rust installer discipline:
stage in `.tmp`, verify hashes, smoke-test, and rename atomically.

1. Download the standalone `uv` binary for the host platform from its GitHub
   release, verifying its published sha256.
2. `uv` installs a managed Python 3.12 and `mykg==<pinned>` into
   `runtime/versions/<v>/`.
3. Download the embedding model.

The smoke test runs `mykg --help` and validates the generated config against
the installed version.

myKG is young and changes quickly (70 releases in about 5 months, and its
README contradicts its code in places). Orquester therefore ships a pinned
version that it has tested, together with that version's prompt overlay. "Check for updates" only offers newer patch
releases inside that tested line; larger jumps arrive with Orquester
releases. Rollback works like ts-rust.

The plugin needs nothing from the boxes (VM) system. Chats in boxes reach the
tools through the daemon like any other Orquester tool.

## Constraints from the codebase

- There is no generic plugin runtime. The plugin touches:
  - `packages/api/src/plugins.ts` (the ID and `PLUGIN_IDS`)
  - `plugins/catalog.ts`
  - the UI glyph map and `SettingsModal` keywords
  - its own service and routes, wired in `apps/daemon/src/index.ts`
  - a catalog tool family
  - the tab and the settings section

  `secret-files/` is the closest template for the service and its
  plugin-enabled checks.
- Transport types go in `packages/api` first. Persisted schemas and paths go
  in `packages/config`, tolerant of other versions.
- MCP tools stay behind `DaemonApi`.
- No dynamic `import()` under `agent-host`.
- Agent-host protocol additions must stay compatible across daemon
  handovers.
- Credentials stay in account homes. The plugin only ever reaches an account
  through a normal agent-chat session.
- Tests:
  - routes and the service, with fake worker sessions answering the inbox
  - the worker tools: instructions sent once per session, JSON validation
    and redo, the atomic answer-then-done order, retiring a session at its
    budget
  - visibility filtering: hidden collections never appear in search, get,
    neighbourhoods or paths
  - the dedup rule
  - debounce and coalescing, driven by injected clocks or events, not sleeps
  - the installer, with fixture deps
  - a myKG round trip against recorded task answers, to catch behaviour
    changes when the pinned version moves

## Left to the builder

- The embedding runtime and model choice, within the constraints above.
- The graph rendering library.
- The worker session's context budget and its instruction text.
- The exact debounce, drift and concurrency defaults.
- Entry ID format, snippet length, and the fusion method.
- How myKG's ID slugging (it keeps only `[a-z0-9]`) is protected against
  collisions for non-Latin names, for example by checking merged concepts
  for unrelated source entries.
