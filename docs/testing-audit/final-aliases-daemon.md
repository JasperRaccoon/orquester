# Final daemon test title aliases

These two surviving titles refer to existing audited baseline identities. This documentation adds no tests or baseline count. Source disposition and consolidation remain in [daemon-chat-tools.json](daemon-chat-tools.json); final code was read for traceability only. No code edits or tests were run for this alias pass.

## apps/daemon/src/agent-chat/visual-urls.test.ts:19

**Final title:** a minted URL names the page and expires at its advertised deadline, within 15 minutes

**Disposition:** REWRITE. **Original owner:** `a minted URL is the visual route with exp and sig, valid for 15 minutes` at baseline line 22 in the same path, audit agent `daemon_chat_tools`, baseline `beb7516b10a3c4472399e0f6f2f2b0a187a61186`.

The original `an expired URL is refused` identity at line 34 was consolidated into this lifecycle owner; its disposition is already counted in the source ledger.

- **independentContract:** Agent visuals/session tools design 2026-10-14 §2.2 and the public agent-visual route require a signed URL for exactly this page with an advertised deadline no later than 15 minutes. The same capability must work through that deadline and fail afterward.
- **realRegression:** A renamed/wrong page route, unsigned or mismatched expiry field, capability rejected immediately or too early, accepted after expiry, or lifetime exceeding 15 minutes makes the literal route/lifetime/verify assertions fail.
- **independentOracle:** The test uses literal /api/agent-visuals/session/page prefix and literal 15-minute security ceiling, a fixed independent NOW, and native controlled Date. It verifies the advertised wire exp equals response expiresAt and calls public verify at the returned deadline and one millisecond afterward. No production TTL/key/clock injection calculates expected values.
- **stableSeam:** createVisualUrlSigner().mint and .verify expose returned wire path, expiry and actual random-key cryptographic authorization, with native Date as the only controlled external dependency.
- **refactorResistance:** Assertions do not depend on signature serialization, helper names, key bytes, private fields or exact implementation lifetime below the documented ceiling. HMAC/URL assembly and expiration scheduling can change while the same public behavior passes.
- **uniqueProtection:** This surviving lifecycle owner combines valid creation, public route/expiry consistency and the consolidated expired-URL identity. Tampering tests cover component binding and other-daemon keys; future-signature tests cover excessive remaining validity. Neither proves that an otherwise valid ordinary capability works through its advertised deadline and stops immediately after. Proxy/serving tests do not replace the lowest signer lifetime boundary.

## apps/daemon/src/session-tools/session-tools-refresh.test.ts:207

**Final title:** a refresh of every open chat pushes each chat exactly once and reports each answer

**Disposition:** REWRITE. **Original owner:** `a refresh of every open chat (the boot refresh) pushes each one, at most REFRESH_CONCURRENCY at a time` at baseline line 209 in the same path, audit agent `daemon_chat_tools`, baseline `beb7516b10a3c4472399e0f6f2f2b0a187a61186`.

- **independentContract:** Unified Orquester MCP design 2026-10-15 §9.4/§12.1 and session-tools/README.md require a boot/all-open-chats refresh to push each open chat manifest and return each host application answer.
- **realRegression:** A worker index skips or repeats a chat, all-chat refresh only handles the first batch, or the result map drops/misattributes a host answer. The exact pushed-ID multiset or answer map then differs from the ten independent open-chat fixture IDs.
- **independentOracle:** Ten chosen codex fixture IDs are supplied by the external openThreads dependency. The host boundary only records received IDs and returns literal next-idle; it does not enumerate chats or fabricate the refresher result. Expected pushed multiset and ID→next-idle map are independent fixture data, without importing a production worker-count constant.
- **stableSeam:** SessionToolsRefresher.refresh(null), observed through outgoing public pushToHost(threadId,manifest) effects and the returned Map<string,RefreshAnswer>. Real manifest construction executes against the existing isolated DaemonApi fixture.
- **refactorResistance:** The test accepts serial, bounded parallel or other behavior-preserving scheduling. It ignores push order, helper layout and exact worker count; only complete exactly-once fanout and caller answers matter.
- **uniqueProtection:** The adjacent single-chat push case owns manifest contents, sequencing and individual host response states. It cannot catch a fanout cursor/pool bug that loses or repeats chats across multiple batches. Pure manifest, HTTP route and host application tests never execute daemon refresh(null) over ten open threads, so none supersedes this lowest orchestration owner.
