/**
 * Pixel scrolling → wheel clicks, for backends whose protocol only has wheel
 * buttons (RFB: buttons 4–7). Small deltas add up until they make a whole step,
 * the same 50 px step noVNC uses for a real wheel.
 */

export const WHEEL_STEP_PX = 50;

export interface WheelSteps {
  /** Whole steps on each axis: positive x scrolls right, positive y scrolls down. */
  x: number;
  y: number;
}

export class WheelAccumulator {
  private x = 0;
  private y = 0;

  /** Add a pixel delta (positive dy: scroll down) and take the whole steps it completes. */
  add(dx: number, dy: number): WheelSteps {
    this.x += dx;
    this.y += dy;
    // `+ 0` turns a -0 into 0.
    const x = Math.trunc(this.x / WHEEL_STEP_PX) + 0;
    const y = Math.trunc(this.y / WHEEL_STEP_PX) + 0;
    this.x -= x * WHEEL_STEP_PX;
    this.y -= y * WHEEL_STEP_PX;
    return { x, y };
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
  }
}
