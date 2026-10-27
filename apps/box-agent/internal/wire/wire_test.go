package wire

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// The fixtures are written from typed TypeScript values (src/fixtures.ts).
// Decoding strictly and re-encoding must give the same JSON: a field the Go
// structs lack, misname or drop fails here.

func readFixture(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name+".json"))
	if err != nil {
		t.Fatalf("reading fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("parsing fixture %s: %v", name, err)
	}
}

func normalize(t *testing.T, raw []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	return v
}

// roundTrip decodes `raw` strictly into `into`, re-encodes it, and compares.
func roundTrip(t *testing.T, label string, raw json.RawMessage, into any) {
	t.Helper()
	if err := Unmarshal(raw, into, true); err != nil {
		t.Errorf("%s: strict decode failed: %v\n%s", label, err, raw)
		return
	}
	again, err := json.Marshal(into)
	if err != nil {
		t.Errorf("%s: encode failed: %v", label, err)
		return
	}
	if want, got := normalize(t, raw), normalize(t, again); !reflect.DeepEqual(want, got) {
		t.Errorf("%s: round trip differs\nwant %s\ngot  %s", label, raw, again)
	}
}

func TestConstants(t *testing.T) {
	var c struct {
		ProtocolVersion    int      `json:"protocolVersion"`
		ChannelWindowBytes int      `json:"channelWindowBytes"`
		MaxFramePayload    int      `json:"maxFramePayload"`
		HeartbeatMs        int      `json:"heartbeatMs"`
		DetachBufferBytes  int      `json:"detachBufferBytes"`
		WindowsPathPrefix  string   `json:"windowsPathPrefix"`
		Platforms          []string `json:"platforms"`
	}
	readFixture(t, "constants", &c)
	if c.ProtocolVersion != ProtocolVersion || c.ChannelWindowBytes != ChannelWindowBytes ||
		c.MaxFramePayload != MaxFramePayload || c.HeartbeatMs != HeartbeatMs ||
		c.DetachBufferBytes != DetachBufferBytes || c.WindowsPathPrefix != WindowsPathPrefix {
		t.Fatalf("constants drifted from box-protocol.ts: %+v", c)
	}
	if !reflect.DeepEqual(c.Platforms, AgentPlatforms) {
		t.Fatalf("platforms drifted: %v vs %v", c.Platforms, AgentPlatforms)
	}
}

func TestControlMessages(t *testing.T) {
	var fixture map[string][]json.RawMessage
	readFixture(t, "control", &fixture)
	for kind, samples := range fixture {
		if len(samples) == 0 {
			t.Errorf("no samples for %s", kind)
		}
		for i, raw := range samples {
			msg, err := DecodeControl(raw, true)
			if err != nil {
				t.Errorf("%s[%d]: %v", kind, i, err)
				continue
			}
			again, _ := json.Marshal(msg)
			if want, got := normalize(t, raw), normalize(t, again); !reflect.DeepEqual(want, got) {
				t.Errorf("%s[%d]: round trip differs\nwant %s\ngot  %s", kind, i, raw, again)
			}
			if open, ok := msg.(*Open); ok {
				if _, _, err := DecodeSpec(open.Spec, true); err != nil {
					t.Errorf("%s[%d] spec: %v", kind, i, err)
				}
			}
		}
	}
	for _, t2 := range []string{"hello", "welcome", "reject", "ping", "pong", "req", "res", "event", "open", "opened", "open-failed", "eof", "exit", "resize", "signal", "credit", "close"} {
		if _, ok := fixture[t2]; !ok {
			t.Errorf("Go decodes %q but the fixture has no such message type", t2)
		}
	}
}

func TestChannelSpecs(t *testing.T) {
	var fixture map[string][]json.RawMessage
	readFixture(t, "channels", &fixture)
	for kind := range ChannelKinds {
		if _, ok := fixture[kind]; !ok {
			t.Errorf("Go knows channel kind %q that box-protocol.ts does not", kind)
		}
	}
	for kind, samples := range fixture {
		ctor, ok := ChannelKinds[kind]
		if !ok {
			t.Errorf("channel kind %q missing in Go", kind)
			continue
		}
		for i, raw := range samples {
			roundTrip(t, kind+"["+string(rune('0'+i))+"]", raw, ctor())
			if got, _, err := DecodeSpec(raw, true); err != nil || got != kind {
				t.Errorf("%s[%d]: DecodeSpec gave %q, %v", kind, i, got, err)
			}
		}
	}
}

type methodSample struct {
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
}

func checkMethods(t *testing.T, label string, fixture map[string][]methodSample, goSide map[string]MethodTypes) {
	var names []string
	for name := range fixture {
		names = append(names, name)
		if _, ok := goSide[name]; !ok {
			t.Errorf("%s: method %q missing in Go", label, name)
		}
	}
	for name := range goSide {
		if _, ok := fixture[name]; !ok {
			t.Errorf("%s: Go has method %q that box-protocol.ts does not", label, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		types, ok := goSide[name]
		if !ok {
			continue
		}
		for i, sample := range fixture[name] {
			roundTrip(t, name+" params", sample.Params, types.Params())
			isNull := len(sample.Result) == 0 || string(sample.Result) == "null"
			if types.Result == nil {
				if !isNull {
					t.Errorf("%s[%d]: Go treats the result as void but the fixture has %s", name, i, sample.Result)
				}
				continue
			}
			if !isNull {
				roundTrip(t, name+" result", sample.Result, types.Result())
			}
		}
	}
}

func TestMethods(t *testing.T) {
	var fixture struct {
		HostToBox map[string][]methodSample `json:"hostToBox"`
		BoxToHost map[string][]methodSample `json:"boxToHost"`
	}
	readFixture(t, "methods", &fixture)
	checkMethods(t, "host→box", fixture.HostToBox, HostToBoxMethods)
	checkMethods(t, "box→host", fixture.BoxToHost, BoxToHostMethods)
}

func TestDataFrames(t *testing.T) {
	var frames []struct {
		Channel    uint32 `json:"channel"`
		Stream     byte   `json:"stream"`
		PayloadHex string `json:"payloadHex"`
		FrameHex   string `json:"frameHex"`
	}
	readFixture(t, "frames", &frames)
	for _, f := range frames {
		payload, _ := hex.DecodeString(f.PayloadHex)
		frame, err := EncodeDataFrame(f.Channel, f.Stream, payload)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(frame) != f.FrameHex {
			t.Errorf("frame for channel %d differs: %x vs %s", f.Channel, frame, f.FrameHex)
		}
		ch, stream, got, err := DecodeDataFrame(frame)
		if err != nil || ch != f.Channel || stream != f.Stream || hex.EncodeToString(got) != f.PayloadHex {
			t.Errorf("decode of channel %d frame failed: %v", f.Channel, err)
		}
	}
	if _, _, _, err := DecodeDataFrame([]byte{0, 0, 0, 1, 3}); err == nil {
		t.Error("stream 3 must be rejected")
	}
	if _, err := EncodeDataFrame(1, 1, make([]byte, MaxFramePayload+1)); err == nil {
		t.Error("oversized payload must be rejected")
	}
}

func TestShutdownUninstallFlag(t *testing.T) {
	var removed ShutdownParams
	if err := Unmarshal([]byte(`{"reason":"removed","uninstall":true}`), &removed, true); err != nil || !removed.Uninstall || removed.Reason != "removed" {
		t.Fatalf("removed = %+v, err %v", removed, err)
	}
	// An older daemon sends no flag: shutting down must not uninstall anything.
	var destroyed ShutdownParams
	if err := Unmarshal([]byte(`{"reason":"destroyed"}`), &destroyed, true); err != nil || destroyed.Uninstall {
		t.Fatalf("destroyed = %+v, err %v", destroyed, err)
	}
	if out, _ := json.Marshal(destroyed); string(out) != `{"reason":"destroyed"}` {
		t.Fatalf("encoded %s", out)
	}
}
