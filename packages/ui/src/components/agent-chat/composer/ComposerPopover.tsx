// Moved to `primitives/ComposerPopover.tsx`: the timeline and the banner cards
// use it too, and nothing on the chat's render path may import `composer/`.
// Kept until the timeline's last import of it here moves.
export { ComposerMenuRow, ComposerPopover } from "../primitives/ComposerPopover";
export type { ComposerMenuRowProps, ComposerPopoverProps, ComposerPopoverTriggerProps } from "../primitives/ComposerPopover";
