/**
 * The panel's screenshot (to the composer or a download), upright: serve-sim streams the iOS
 * framebuffer in portrait even while the simulator is in landscape (its `0x82` screen config says
 * the orientation), so the captured frame is turned the way the flat view turns it
 * (`flatMediaRotation`). Android emulators rotate their own framebuffer: no turn.
 */

export type ScreenshotTurn = 0 | 90 | -90 | 180;

/** The part of a 2D context the turn uses. */
interface TurnContext<S> {
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  drawImage(source: S, x: number, y: number): void;
}

/** Draw `source` (`width`×`height`) turned clockwise by `turn` into `ctx`; answers the output size. */
export function drawTurned<S>(ctx: TurnContext<S>, source: S, width: number, height: number, turn: ScreenshotTurn): { width: number; height: number } {
  switch (turn) {
    case 90:
      ctx.translate(height, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case -90:
      ctx.translate(0, width);
      ctx.rotate(-Math.PI / 2);
      break;
    case 180:
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      break;
    case 0:
      break;
  }
  ctx.drawImage(source, 0, 0);
  return turn === 90 || turn === -90 ? { width: height, height: width } : { width, height };
}

/** `canvas` as an upright copy (the same canvas when no turn is needed). */
export function uprightCanvas(canvas: HTMLCanvasElement, turn: ScreenshotTurn): HTMLCanvasElement {
  if (turn === 0) return canvas;
  const out = document.createElement("canvas");
  const sideways = turn === 90 || turn === -90;
  out.width = sideways ? canvas.height : canvas.width;
  out.height = sideways ? canvas.width : canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) return canvas;
  drawTurned<CanvasImageSource>(ctx, canvas, canvas.width, canvas.height, turn);
  return out;
}
