import { createEffect, onCleanup } from "solid-js";
import type { StoryCanvas } from "../../../lib/story-canvas.ts";
import { useI18n } from "../../../lib/i18n.tsx";

// File size limit
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

interface UseStoryImageUploadOptions {
  storyCanvas: StoryCanvas | null;
  selectLayer: (id: string | null) => void;
  setUploading: (value: boolean) => void;
  setError: (message: string) => void;
  onUpdate: () => void;
  canEdit: () => boolean;
}

export function useStoryImageUpload(opts: UseStoryImageUploadOptions) {
  const { t } = useI18n();
  let fileInputRef!: HTMLInputElement;
  const objectUrls = new Set<string>();
  let selecting = false;

  // Cleanup object URLs on unmount to prevent memory leaks
  createEffect(() => {
    onCleanup(() => {
      objectUrls.forEach((url) => {
        URL.revokeObjectURL(url);
      });
      objectUrls.clear();
    });
  });

  const handleImageSelect = async (
    e: Event & { currentTarget: HTMLInputElement },
  ) => {
    if (selecting || !opts.canEdit()) return;
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file || !opts.storyCanvas) return;

    if (!file.type.startsWith("image/")) {
      opts.setError(t("story.selectImageFile"));
      return;
    }

    if (file.size > MAX_IMAGE_SIZE) {
      opts.setError(
        t("story.imageTooLarge").replace(
          "{size}",
          String(MAX_IMAGE_SIZE / 1024 / 1024),
        ),
      );
      return;
    }

    selecting = true;
    opts.setUploading(true);
    try {
      const preview = URL.createObjectURL(file);
      // Track the object URL for cleanup
      objectUrls.add(preview);
      const layer = await opts.storyCanvas.createMediaLayer(preview);
      opts.storyCanvas.addLayer(layer);
      opts.selectLayer(layer.id);
      opts.onUpdate();
    } catch (err) {
      console.error("Failed to add image:", err);
      opts.setError(t("story.mediaUploadFailed"));
    } finally {
      selecting = false;
      opts.setUploading(false);
      if (fileInputRef) fileInputRef.value = "";
    }
  };

  return {
    get fileInputRef() {
      return fileInputRef;
    },
    set fileInputRef(el: HTMLInputElement) {
      fileInputRef = el;
    },
    handleImageSelect,
  };
}
