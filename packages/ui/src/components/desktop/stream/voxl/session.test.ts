import test from "node:test";
import assert from "node:assert/strict";

import { VOXL_KEYFRAME_THROTTLE_MS, VoxlStreamSession, type VoxlChunk, type VoxlStripePart } from "./session.ts";

interface Frame {
  timestamp: number;
  stripe: number;
  closed: boolean;
  close(): void;
}

/** A session on fake decoders whose output the test releases by hand. */
function harness() {
  const sent: string[] = [];
  const presented: { stripe: number; y: number; ts: number }[][] = [];
  const decoders: { stripe: number; codec: string; chunks: VoxlChunk[]; closed: boolean; output: (ts: number) => Frame }[] = [];
  let configuring = 0;
  const session = new VoxlStreamSession<Frame>({
    send: (text) => sent.push(text),
    present: (parts: VoxlStripePart<Frame>[]) => {
      presented.push(parts.map((p) => ({ stripe: p.stripe, y: p.y, ts: p.frame.timestamp })));
      for (const p of parts) p.frame.close();
    },
    emit: () => undefined,
    createDecoder: (codec, output) => {
      const stripe = configuring;
      const decoder = {
        stripe,
        codec,
        chunks: [] as VoxlChunk[],
        closed: false,
        output: (ts: number) => {
          const frame: Frame = { timestamp: ts, stripe, closed: false, close: () => (frame.closed = true) };
          output(frame);
          return frame;
        }
      };
      decoders.push(decoder);
      return {
        get state() {
          return decoder.closed ? "closed" : "configured";
        },
        decode: (chunk) => decoder.chunks.push(chunk),
        close: () => {
          decoder.closed = true;
        }
      };
    }
  });
  const video = (opts: { frame: number; stripe: number; parts: number; key?: boolean }) => {
    configuring = opts.stripe;
    const sps = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28];
    const payload = opts.key ? sps : [0, 0, 0, 1, 0x41, 0x9a];
    const b = new Uint8Array(16 + payload.length);
    b[0] = 0x01;
    b[1] = opts.key ? 1 : 0;
    new DataView(b.buffer).setUint32(2, opts.frame);
    b[10] = opts.stripe;
    b[11] = 2;
    b[12] = opts.parts;
    b.set(payload, 16);
    session.handleBinary(b.buffer);
  };
  const decoderFor = (stripe: number) => decoders.filter((d) => d.stripe === stripe && !d.closed).at(-1)!;
  return { session, sent, presented, decoders, video, decoderFor };
}

const twoStripeHello = '{"t":"hello","w":1920,"h":1080,"stripes":[[0,544],[544,536]]}';

test("stripes decoded out of order present whole frames in order, each acked after it is shown", () => {
  const h = harness();
  h.session.handleText(twoStripeHello);
  h.video({ frame: 1, stripe: 0, parts: 2, key: true });
  h.video({ frame: 1, stripe: 1, parts: 2, key: true });
  h.video({ frame: 2, stripe: 0, parts: 2 });
  h.video({ frame: 2, stripe: 1, parts: 2 });
  assert.equal(h.decoderFor(0).codec, "avc1.640028");
  // Each decoder got its stripe's chunks, keyframe first.
  assert.deepEqual(h.decoderFor(1).chunks.map((c) => c.type), ["key", "delta"]);

  const s0 = h.decoderFor(0);
  const s1 = h.decoderFor(1);
  s1.output(s1.chunks[0]!.timestamp); // frame 1, stripe 1
  s0.output(s0.chunks[1]!.timestamp); // frame 2, stripe 0
  s1.output(s1.chunks[1]!.timestamp); // frame 2, stripe 1: frame 2 is complete but frame 1 is not
  assert.equal(h.presented.length, 0);
  assert.ok(!h.sent.some((s) => s.startsWith("a,")));

  s0.output(s0.chunks[0]!.timestamp); // frame 1, stripe 0
  assert.deepEqual(
    h.presented.map((parts) => parts.map((p) => [p.stripe, p.y]).sort()),
    [
      [
        [0, 0],
        [1, 544]
      ],
      [
        [0, 0],
        [1, 544]
      ]
    ]
  );
  assert.deepEqual(h.sent.filter((s) => s.startsWith("a,")), ["a,1", "a,2"]);
});

test("a stripe without its keyframe drops out of the frame and asks for one", () => {
  const h = harness();
  h.session.handleText(twoStripeHello);
  h.video({ frame: 5, stripe: 0, parts: 2, key: true });
  h.video({ frame: 5, stripe: 1, parts: 2 }); // stripe 1 has no decoder yet
  assert.ok(h.sent.includes("kf"));
  const s0 = h.decoderFor(0);
  s0.output(s0.chunks[0]!.timestamp);
  assert.deepEqual(h.presented.map((parts) => parts.map((p) => p.stripe)), [[0]]);
  assert.deepEqual(h.sent.filter((s) => s.startsWith("a,")), ["a,5"]);
  h.session.close();
});

test("keyframe requests go out at most once per 500 ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.session.handleText(twoStripeHello);
  const kf = () => h.sent.filter((s) => s === "kf").length;
  h.video({ frame: 1, stripe: 0, parts: 1 });
  h.video({ frame: 2, stripe: 0, parts: 1 });
  assert.equal(kf(), 1);
  t.mock.timers.tick(VOXL_KEYFRAME_THROTTLE_MS - 1);
  h.video({ frame: 3, stripe: 0, parts: 1 });
  assert.equal(kf(), 1);
  t.mock.timers.tick(1);
  h.video({ frame: 4, stripe: 0, parts: 1 });
  assert.equal(kf(), 2);
  h.session.close();
});

test("a new hello (after a resize) restarts the decoders and drops frames in flight", () => {
  const h = harness();
  h.session.handleText(twoStripeHello);
  h.video({ frame: 1, stripe: 0, parts: 2, key: true });
  const old = h.decoderFor(0);
  h.session.handleText('{"t":"hello","w":1280,"h":800,"stripes":[[0,800]]}');
  assert.equal(old.closed, true);
  // The old decoder's late output is not shown and does not ack.
  const late = old.output(old.chunks[0]!.timestamp);
  assert.equal(late.closed, true);
  assert.equal(h.presented.length, 0);
  // The new stream needs a keyframe again.
  h.video({ frame: 2, stripe: 0, parts: 1 });
  assert.ok(h.sent.includes("kf"));
  h.session.close();
});

test("pings are answered with the server's timestamp", () => {
  const h = harness();
  h.session.handleText('{"t":"ping","s":987654321}');
  assert.deepEqual(h.sent, ["po,987654321"]);
});

test("resuming video restarts from a keyframe", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.session.open();
  h.session.setVideo(false);
  h.session.setVideo(true);
  assert.deepEqual(h.sent, ["v,1", "au,0", "v,0", "v,1", "kf"]);
  h.session.close();
});
