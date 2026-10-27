import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilities, chooseTransport, NO_BROWSER_CAPS, type BrowserStreamCaps } from "./capabilities.ts";
import { fakeVideoDecoderClass } from "./testing/fakes.ts";

const full: BrowserStreamCaps = { webCodecs: true, h264Baseline: true, h264High: true };
const baselineOnly: BrowserStreamCaps = { webCodecs: true, h264Baseline: true, h264High: false };

describe("chooseTransport", () => {
  const cases: Array<[string, Parameters<typeof chooseTransport>[0], string]> = [
    ["android + WebCodecs", { platform: "android", browserCaps: full }, "serve-emu"],
    ["android + Baseline only", { platform: "android", browserCaps: baselineOnly }, "serve-emu"],
    ["android without WebCodecs", { platform: "android", browserCaps: NO_BROWSER_CAPS }, "screenshots"],
    [
      "android, WebCodecs without H.264",
      { platform: "android", browserCaps: { webCodecs: true, h264Baseline: false, h264High: false } },
      "screenshots"
    ],
    ["ios, host H.264 + browser H.264", { platform: "ios", hostCaps: { h264: true }, browserCaps: full }, "serve-sim-h264"],
    ["ios, Blacksmith VM (no host H.264)", { platform: "ios", hostCaps: { h264: false }, browserCaps: full }, "serve-sim-mjpeg"],
    ["ios, host caps unknown", { platform: "ios", browserCaps: full }, "serve-sim-mjpeg"],
    ["ios, host H.264, no WebCodecs", { platform: "ios", hostCaps: { h264: true }, browserCaps: NO_BROWSER_CAPS }, "serve-sim-mjpeg"],
    ["ios, host H.264, browser without High", { platform: "ios", hostCaps: { h264: true }, browserCaps: baselineOnly }, "serve-sim-mjpeg"]
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(chooseTransport(input), expected));
  }
});

describe("capabilities", () => {
  it("reports no WebCodecs when VideoDecoder or EncodedVideoChunk is missing", async () => {
    assert.deepEqual(await capabilities(undefined, undefined), NO_BROWSER_CAPS);
    const { VideoDecoder } = fakeVideoDecoderClass();
    assert.deepEqual(await capabilities(VideoDecoder, undefined), NO_BROWSER_CAPS);
  });

  it("probes Baseline and High with optimizeForLatency", async () => {
    const { VideoDecoder, EncodedVideoChunk, log } = fakeVideoDecoderClass({ supported: (codec) => codec.startsWith("avc1.42") });
    assert.deepEqual(await capabilities(VideoDecoder, EncodedVideoChunk), baselineOnly);
    assert.deepEqual(log.supportQueries.sort(), ["avc1.42c020", "avc1.640033"]);
  });

  it("treats a throwing probe as unsupported", async () => {
    const { VideoDecoder, EncodedVideoChunk } = fakeVideoDecoderClass();
    (VideoDecoder as unknown as { isConfigSupported: () => Promise<never> }).isConfigSupported = () => Promise.reject(new TypeError("bad"));
    assert.deepEqual(await capabilities(VideoDecoder, EncodedVideoChunk), { webCodecs: true, h264Baseline: false, h264High: false });
  });
});
