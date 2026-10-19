import type { RepoIconStoredType } from "@orquester/api";

/**
 * What a repo icon's bytes really are, judged from the bytes alone — never from
 * a declared content type or a file name. Null when they are none of the
 * stored icon types ({@link RepoIconStoredType}).
 *
 * SVG is text, so it has no magic number: it counts when the document (after
 * an optional BOM, XML declaration, comments and doctype) opens with an `<svg`
 * root element and closes it. That is a shape check, not sanitizing — an SVG
 * is only ever shown through `<img>`, where its scripts do not run.
 */
export function sniffRepoIcon(bytes: Uint8Array): RepoIconStoredType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  // ICONDIR: reserved 0, type 1 (icon), then a non-zero image count.
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6 && (bytes[4] !== 0 || bytes[5] !== 0)) {
    return "image/x-icon";
  }
  return isSvgDocument(bytes) ? "image/svg+xml" : null;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

function isSvgDocument(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  let rest = text.replace(/^﻿/, "");
  // Prolog: XML declaration, comments, processing instructions, a doctype — any order, any count.
  for (;;) {
    rest = rest.trimStart();
    const prolog = /^(<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>)/i.exec(rest);
    if (!prolog) break;
    rest = rest.slice(prolog[0].length);
  }
  if (!/^<svg[\s>/]/i.test(rest)) return false;
  // A self-closing root, or a closing tag at the end (trailing comments/whitespace allowed).
  if (/^<svg\b[^>]*\/>\s*(<!--[\s\S]*?-->\s*)*$/i.test(rest)) return true;
  return /<\/svg\s*>\s*(<!--[\s\S]*?-->\s*)*$/i.test(rest);
}
