/**
 * Sticker Panel for Story Editor
 *
 * Provides emoji picker for adding sticker layers.
 */

import { EmojiPicker } from "./EmojiPicker.tsx";

interface StickerPanelProps {
  onAddEmoji: (emoji: string) => void;
}

// No heading of its own: the composer's sticker panel already titles it
// スタンプ, and the picker showed a second スタンプ under the poll / note /
// link stickers.
export function StickerPanel(props: StickerPanelProps) {
  return <EmojiPicker onSelect={props.onAddEmoji} />;
}
