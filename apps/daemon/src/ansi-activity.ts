type ScannerState = "ground" | "esc" | "csi" | "string" | "string-esc";

const BEL = 0x07;
const ESC = 0x1b;
const CSI = 0x9b;
const DCS = 0x90;
const SOS = 0x98;
const OSC = 0x9d;
const ST = 0x9c;
const PM = 0x9e;
const APC = 0x9f;

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isStringIntroducer(code: number): boolean {
  return code === DCS || code === SOS || code === OSC || code === PM || code === APC;
}

export class BellScanner {
  private state: ScannerState = "ground";
  private stringBelTerminates = false;

  feed(chunk: string): number {
    let bells = 0;

    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      const ch = chunk[i];

      switch (this.state) {
        case "ground":
          if (code === BEL) {
            bells++;
          } else if (code === ESC) {
            this.state = "esc";
          } else if (code === CSI) {
            this.state = "csi";
          } else if (isStringIntroducer(code)) {
            this.state = "string";
            this.stringBelTerminates = code === OSC;
          }
          break;

        case "esc":
          if (ch === "[") {
            this.state = "csi";
          } else if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
            this.state = "string";
            this.stringBelTerminates = ch === "]";
          } else if (ch === "\\") {
            this.state = "ground";
          } else if (code === ESC) {
            this.state = "esc";
          } else if (code === CSI) {
            this.state = "csi";
          } else if (isStringIntroducer(code)) {
            this.state = "string";
            this.stringBelTerminates = code === OSC;
          } else {
            this.state = "ground";
          }
          break;

        case "csi":
          if (code === ESC) {
            this.state = "esc";
          } else if (isCsiFinal(code)) {
            this.state = "ground";
          }
          break;

        case "string":
          if (code === ESC) {
            this.state = "string-esc";
          } else if (code === ST) {
            this.state = "ground";
          } else if (code === BEL) {
            this.state = "ground";
          }
          break;

        case "string-esc":
          if (ch === "\\") {
            this.state = "ground";
          } else if (code === ESC) {
            this.state = "string-esc";
          } else {
            this.state = "string";
          }
          break;
      }
    }

    return bells;
  }
}

export interface ActivitySnapshot {
  lastOutputAt: number | null;
  attention: boolean;
}

export class ActivityTracker {
  private readonly scanner = new BellScanner();
  private lastOutputAt: number | null = null;
  private attention = false;

  onOutput(chunk: string, now: number): boolean {
    this.lastOutputAt = now;
    const rang = this.scanner.feed(chunk) > 0;
    if (rang) {
      this.attention = true;
    }
    return rang;
  }

  onInput(): void {
    this.attention = false;
  }

  snapshot(): ActivitySnapshot {
    return {
      lastOutputAt: this.lastOutputAt,
      attention: this.attention,
    };
  }
}
