import React from "react";

import { fileIconIdFor, type FileIconId } from "../../lib/file-icon";

import Audio from "./audio.svg?react";
import C from "./c.svg?react";
import Console from "./console.svg?react";
import Cpp from "./cpp.svg?react";
import Csharp from "./csharp.svg?react";
import Css from "./css.svg?react";
import Database from "./database.svg?react";
import Document from "./document.svg?react";
import File from "./file.svg?react";
import Font from "./font.svg?react";
import Go from "./go.svg?react";
import Html from "./html.svg?react";
import Image from "./image.svg?react";
import Java from "./java.svg?react";
import Javascript from "./javascript.svg?react";
import Json from "./json.svg?react";
import Jupyter from "./jupyter.svg?react";
import Lock from "./lock.svg?react";
import Log from "./log.svg?react";
import Markdown from "./markdown.svg?react";
import Pdf from "./pdf.svg?react";
import Php from "./php.svg?react";
import Powerpoint from "./powerpoint.svg?react";
import Powershell from "./powershell.svg?react";
import Python from "./python.svg?react";
import React_ from "./react.svg?react";
import ReactTs from "./react_ts.svg?react";
import Ruby from "./ruby.svg?react";
import Rust from "./rust.svg?react";
import Sass from "./sass.svg?react";
import Svg from "./svg.svg?react";
import Swift from "./swift.svg?react";
import Table from "./table.svg?react";
import Toml from "./toml.svg?react";
import Typescript from "./typescript.svg?react";
import Video from "./video.svg?react";
import Word from "./word.svg?react";
import Xml from "./xml.svg?react";
import Yaml from "./yaml.svg?react";
import Zip from "./zip.svg?react";

type SvgIcon = React.FunctionComponent<React.SVGProps<SVGSVGElement>>;

/**
 * One vendored SVG per id; the `Record` makes a missing MAPPING a typecheck
 * error; a missing FILE is caught by `file-icon.test.ts`.
 */
export const FILE_ICONS: Record<FileIconId, SvgIcon> = {
  table: Table, word: Word, powerpoint: Powerpoint, pdf: Pdf, json: Json, yaml: Yaml, toml: Toml,
  xml: Xml, database: Database, jupyter: Jupyter, zip: Zip, typescript: Typescript,
  react_ts: ReactTs, javascript: Javascript, react: React_, python: Python, rust: Rust, go: Go,
  java: Java, c: C, cpp: Cpp, csharp: Csharp, ruby: Ruby, php: Php, swift: Swift,
  console: Console, powershell: Powershell, html: Html, css: Css, sass: Sass,
  markdown: Markdown, document: Document, log: Log, image: Image, svg: Svg, audio: Audio,
  video: Video, lock: Lock, font: Font, file: File
};

export interface FileTypeIconProps {
  name?: string;
  mimeType?: string;
  size?: number;
  className?: string;
}

/**
 * The file-type glyph for an attachment: a Material Icon Theme SVG picked by
 * extension, then mime (`lib/file-icon.ts`). `data-file-icon` is the hook the
 * light-mode filter in `globals.css` uses — nothing here branches on the mode.
 */
export function FileTypeIcon({ name, mimeType, size = 16, className }: FileTypeIconProps): React.ReactElement {
  const Icon = FILE_ICONS[fileIconIdFor({ name, mimeType })];
  return <Icon width={size} height={size} aria-hidden data-file-icon="" className={className} />;
}
