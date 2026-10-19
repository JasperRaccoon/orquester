import assert from "node:assert/strict";
import test from "node:test";
import { sniffRepoIcon } from "./image-sniff.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

test("sniffRepoIcon recognizes each stored type by its bytes", () => {
  assert.equal(sniffRepoIcon(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), "image/png");
  assert.equal(sniffRepoIcon(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffRepoIcon(text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), "image/webp");
  assert.equal(sniffRepoIcon(bytes(0, 0, 1, 0, 1, 0, 16, 16)), "image/x-icon");
  assert.equal(sniffRepoIcon(text('<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>')), "image/svg+xml");
});

test("sniffRepoIcon accepts an SVG prolog, a self-closing root and trailing comments", () => {
  assert.equal(sniffRepoIcon(text('﻿<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n<svg>\n</svg>\n')), "image/svg+xml");
  assert.equal(sniffRepoIcon(text("<svg viewBox='0 0 1 1'/>")), "image/svg+xml");
  assert.equal(sniffRepoIcon(text("<svg></svg><!-- end -->\n")), "image/svg+xml");
});

test("sniffRepoIcon refuses everything else", () => {
  assert.equal(sniffRepoIcon(bytes()), null);
  assert.equal(sniffRepoIcon(text("GIF89a")), null);
  assert.equal(sniffRepoIcon(text("RIFF\u0000\u0000\u0000\u0000WAVE")), null, "RIFF but not WebP");
  assert.equal(sniffRepoIcon(bytes(0, 0, 1, 0, 0, 0)), null, "an ICONDIR with no images");
  assert.equal(sniffRepoIcon(bytes(0, 0, 2, 0, 1, 0)), null, "a cursor, not an icon");
  assert.equal(sniffRepoIcon(text("<html><svg></svg></html>")), null, "SVG not at the root");
  assert.equal(sniffRepoIcon(text("<svg><g>")), null, "unclosed root");
  assert.equal(sniffRepoIcon(text("<svgfoo></svgfoo>")), null);
  assert.equal(sniffRepoIcon(bytes(0x3c, 0x73, 0x76, 0x67, 0x3e, 0xff, 0xfe)), null, "not UTF-8");
});

test("sniffRepoIcon reads doctype subsets, any case, and stops at a comment body holding -->", () => {
  assert.equal(sniffRepoIcon(text('<!doctype svg [ <!ENTITY a "x>y"> ]  >\n<SVG></SVG >')), "image/svg+xml");
  assert.equal(sniffRepoIcon(text("<svg></svg>\n<!-- a -->\n<!-- b -->  ")), "image/svg+xml");
  assert.equal(sniffRepoIcon(text("<svg/> <!-- a --> b -->")), null, "junk after a comment");
  assert.equal(sniffRepoIcon(text("<svg></svg><!-->")), null, "an unclosed trailing comment");
  assert.equal(sniffRepoIcon(text("<!DOCTYPE svg [ <!ENTITY a 'b'> <svg></svg>")), null, "an unclosed doctype subset");
  assert.equal(sniffRepoIcon(text("<?xml version='1.0' <svg></svg>")), null, "an unclosed declaration");
});

test("sniffRepoIcon answers adversarial SVG-ish text in linear time", () => {
  const timed = (input: string): { result: string | null; ms: number } => {
    const encoded = text(input);
    const started = performance.now();
    const result = sniffRepoIcon(encoded);
    return { result, ms: performance.now() - started };
  };
  // The first took effectively forever, the rest seconds, with the old nested-quantifier regexes.
  const cases = [
    `<svg/>${"<!---->".repeat(60)}x`,
    `<svg></svg>${"<!---->".repeat(60)}x`,
    `<svg/>${"<!---->".repeat(20_000)}x`,
    `<!DOCTYPE${" ".repeat(50_000)}`,
    `<!DOCTYPE [${"]".repeat(50_000)}`,
    `<svg>${"</svg>".repeat(20_000)}x`
  ];
  for (const input of cases) {
    const { result, ms } = timed(input);
    assert.equal(result, null);
    assert.ok(ms < 100, `${input.slice(0, 20)}... took ${ms.toFixed(1)} ms`);
  }
  const valid = timed(`<svg></svg>${"<!---->".repeat(20_000)}`);
  assert.equal(valid.result, "image/svg+xml");
  assert.ok(valid.ms < 100, `trailing comments took ${valid.ms.toFixed(1)} ms`);
});
