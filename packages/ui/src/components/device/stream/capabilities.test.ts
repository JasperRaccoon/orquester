import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chooseTransport, type BrowserStreamCaps } from "./capabilities.ts";
import { browserApis, fakeVideoDecoderClass, restoreBrowserApis } from "./testing/fakes.ts";

afterEach(restoreBrowserApis);
const none: BrowserStreamCaps = { webCodecs: false, h264Baseline: false, h264High: false };
const full: BrowserStreamCaps = { webCodecs: true, h264Baseline: true, h264High: true };
const baselineOnly: BrowserStreamCaps = { webCodecs: true, h264Baseline: true, h264High: false };

describe("chooseTransport", () => {
  const cases: Array<[string, Parameters<typeof chooseTransport>[0], string]> = [
    ["android + Baseline only", { platform: "android", browserCaps: baselineOnly }, "serve-emu"],
    [
      "android, WebCodecs without H.264",
      { platform: "android", browserCaps: { webCodecs: true, h264Baseline: false, h264High: false } },
      "screenshots"
    ],
    ["ios, Blacksmith VM (no host H.264)", { platform: "ios", hostCaps: { h264: false }, browserCaps: full }, "serve-sim-mjpeg"],
    ["ios, host caps unknown", { platform: "ios", browserCaps: full }, "serve-sim-mjpeg"],
    ["ios, host H.264, no WebCodecs", { platform: "ios", hostCaps: { h264: true }, browserCaps: none }, "serve-sim-mjpeg"],
    ["ios, host H.264, browser without High", { platform: "ios", hostCaps: { h264: true }, browserCaps: baselineOnly }, "serve-sim-mjpeg"]
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(chooseTransport(input), expected));
  }
});

describe("capabilities", () => {
  it("reports no WebCodecs when VideoDecoder or EncodedVideoChunk is missing", async () => {
    browserApis({ VideoDecoder: undefined, EncodedVideoChunk: undefined });
    const missing = await import("./capabilities.ts?missing" as string);
    assert.deepEqual(await missing.capabilities(), none);
    const { VideoDecoder } = fakeVideoDecoderClass();
    browserApis({ VideoDecoder, EncodedVideoChunk: undefined });
    const noChunks = await import("./capabilities.ts?no-chunks" as string);
    assert.deepEqual(await noChunks.capabilities(), none);
  });

  it("probes Baseline and High with optimizeForLatency", async () => {
    const { VideoDecoder, EncodedVideoChunk, log } = fakeVideoDecoderClass({ supported: (codec) => codec.startsWith("avc1.42") });
    browserApis({ VideoDecoder, EncodedVideoChunk });
    const page = await import("./capabilities.ts?baseline-only" as string);
    assert.deepEqual(await page.capabilities(), baselineOnly);
    assert.deepEqual(log.supportQueries.sort(), ["avc1.42c020", "avc1.640033"]);
  });

  it("treats a throwing probe as unsupported", async () => {
    const { VideoDecoder, EncodedVideoChunk } = fakeVideoDecoderClass();
    (VideoDecoder as unknown as { isConfigSupported: () => Promise<never> }).isConfigSupported = () => Promise.reject(new TypeError("bad"));
    browserApis({ VideoDecoder, EncodedVideoChunk });
    const page = await import("./capabilities.ts?failed-probe" as string);
    assert.deepEqual(await page.capabilities(), { webCodecs: true, h264Baseline: false, h264High: false });
  });
});
