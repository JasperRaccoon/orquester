import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPOSER_RESTING_EXPANSION_MIN_PX,
  isComposerCollapsedMobile,
  resolveComposerTimelineInset
} from "./composer-inset.ts";

test("a resting composer reserves room for the expansion that follows", () => {
  assert.equal(
    resolveComposerTimelineInset({ currentInset: 0, overlayHeight: 56, isResting: true }),
    56 + COMPOSER_RESTING_EXPANSION_MIN_PX
  );
});

test("a resting measurement never shrinks the reservation", () => {
  assert.equal(
    resolveComposerTimelineInset({ currentInset: 400, overlayHeight: 56, isResting: true }),
    400
  );
});

test("an expanded measurement is authoritative and may shrink it", () => {
  assert.equal(
    resolveComposerTimelineInset({ currentInset: 400, overlayHeight: 180, isResting: false }),
    180
  );
});

const COLLAPSIBLE = {
  isMobileViewport: true,
  isFocused: false,
  hasMultilineDraft: false,
  hasAttachments: false,
  hasDockedBanner: false
};

test("the mobile composer collapses only when nothing needs the space", () => {
  assert.equal(isComposerCollapsedMobile(COLLAPSIBLE), true);
  assert.equal(isComposerCollapsedMobile({ ...COLLAPSIBLE, isFocused: true }), false);
  assert.equal(isComposerCollapsedMobile({ ...COLLAPSIBLE, hasMultilineDraft: true }), false);
  assert.equal(isComposerCollapsedMobile({ ...COLLAPSIBLE, hasAttachments: true }), false);
  assert.equal(isComposerCollapsedMobile({ ...COLLAPSIBLE, hasDockedBanner: true }), false);
});

test("a desktop viewport never collapses", () => {
  assert.equal(isComposerCollapsedMobile({ ...COLLAPSIBLE, isMobileViewport: false }), false);
});
