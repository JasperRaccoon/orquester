/**
 * Browser-side device stream client: transport sessions that paint a caller's
 * canvas, input channels, keyboard/text mapping, and `useDeviceStream`.
 */

export { AvccDemuxer, type AvccChunk, type AvccChunkType } from "./avcc.ts";
export { simulatorAvcConfig } from "./avcConfig.ts";
export {
  capabilities,
  chooseTransport,
  NO_BROWSER_CAPS,
  type BrowserStreamCaps,
  type ChooseTransportInput,
  type HostStreamCaps
} from "./capabilities.ts";
export { H264Decoder, paintCanvas } from "./decoder.ts";
export { codecFromAvcC, codecFromSps, scanAccessUnit } from "./h264.ts";
export {
  androidKeycodeForCode,
  chunkText,
  hidStrokeForChar,
  hidUsageForCode,
  mapKeyboardEvent,
  textToHidStrokes,
  type DeviceKeyAction,
  type KeyboardEventLike,
  type KeyPhase
} from "./keymap.ts";
export { MjpegParser, multipartBoundary } from "./mjpeg.ts";
export { clampUnit, createPointerThrottle, type PointerThrottle } from "./pointer.ts";
export { ScreenshotPollSession, type ScreenshotPollOptions } from "./screenshots.ts";
export { parseSemuPacket, type SemuPacket } from "./semu.ts";
export { ServeEmuSession, type ServeEmuSessionOptions } from "./serveEmu.ts";
export { ServeSimH264Session } from "./serveSimH264.ts";
export {
  rawSimulatorPoint,
  ServeSimInputSocket,
  type ServeSimButton,
  type ServeSimInputOptions
} from "./serveSimInput.ts";
export { ServeSimMjpegSession } from "./serveSimMjpeg.ts";
export {
  DeviceStreamError,
  type DeviceButton,
  type DeviceOrientation,
  type DevicePlatform,
  type DeviceScreenConfig,
  type DeviceStreamCallbacks,
  type DeviceStreamErrorCode,
  type DeviceStreamState,
  type DeviceStreamStats,
  type DeviceTransport,
  type DeviceVideoSession,
  type StreamDeps,
  type TouchPhase,
  type VideoSessionOptions
} from "./types.ts";
export {
  serveSimStreamUrl,
  useDeviceStream,
  withQueryParams,
  type DeviceStreamHandle,
  type DeviceStreamUrls,
  type UseDeviceStreamOptions
} from "./useDeviceStream.ts";
