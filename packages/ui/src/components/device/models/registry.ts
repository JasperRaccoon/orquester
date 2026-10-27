// Model URLs for the 3D device viewer. Vite emits each GLB as a hashed asset; this module is
// imported lazily alongside three.js, and never by Node tests (Node cannot load `?url`).
// Provenance of every file is in ./sources.json; the name matching lives in ../three/model.ts.
import type {
  DeviceAccessorySource,
  DeviceModelId,
  DeviceModelSource,
} from "../three/model.ts";
import iphoneDuo from "./iphone-duo.glb?url";
import iphone18Pro from "./iphone-18-pro.glb?url";
import iphone18ProMax from "./iphone-18-pro-max.glb?url";
import iphone17 from "./iphone-17.glb?url";
import iphoneAir from "./iphone-air.glb?url";
import iphone17e from "./iphone-17e.glb?url";
import ipadPro13M5 from "./ipad-pro-13-m5.glb?url";
import ipadAir from "./ipad-air.glb?url";
import ipadA16 from "./ipad-a16.glb?url";
import magicKeyboard from "./ipad-pro-13-m5-magic-keyboard.glb?url";
import galaxyS26 from "./galaxy-s26.glb?url";
import galaxyS26Plus from "./galaxy-s26-plus.glb?url";
import galaxyS26Ultra from "./galaxy-s26-ultra.glb?url";
import galaxyZFold8 from "./galaxy-z-fold8.glb?url";
import galaxyZFlip8 from "./galaxy-z-flip8.glb?url";

const urls: Record<DeviceModelId, string> = {
  "iphone-duo": iphoneDuo,
  "iphone-18-pro": iphone18Pro,
  "iphone-18-pro-max": iphone18ProMax,
  "iphone-17": iphone17,
  "iphone-air": iphoneAir,
  "iphone-17e": iphone17e,
  "ipad-pro-13-m5": ipadPro13M5,
  "ipad-air": ipadAir,
  "ipad-a16": ipadA16,
  "galaxy-s26": galaxyS26,
  "galaxy-s26-plus": galaxyS26Plus,
  "galaxy-s26-ultra": galaxyS26Ultra,
  "galaxy-z-fold8": galaxyZFold8,
  "galaxy-z-flip8": galaxyZFlip8,
};

export function deviceModelSource(id: DeviceModelId): DeviceModelSource {
  return { id, url: urls[id] };
}

const keyboard: DeviceAccessorySource = {
  id: "ipad-pro-13-m5-magic-keyboard",
  modelId: "ipad-pro-13-m5",
  url: magicKeyboard,
};

/** The Magic Keyboard accessory for the model it fits, else null. */
export function deviceKeyboardSource(id: DeviceModelId | null): DeviceAccessorySource | null {
  return id === keyboard.modelId ? keyboard : null;
}
