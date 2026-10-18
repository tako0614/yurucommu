import { Show } from "solid-js";
import type { CommunityDetail } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";

interface CommunityAboutPanelProps {
  community: CommunityDetail;
}

export function CommunityAboutPanel(props: CommunityAboutPanelProps) {
  const { t } = useI18n();
  return (
    <div class="p-4">
      <Show
        when={props.community.summary}
        fallback={
          <div class="text-neutral-500 text-center py-8">
            {t("community.noDescription")}
          </div>
        }
      >
        <div>
          {/* h2 under the community's h1: an h3 skipped a level. */}
          <h2 class="text-lg font-bold mb-2">{t("community.about")}</h2>
          <p class="text-neutral-300 whitespace-pre-wrap">
            {props.community.summary}
          </p>
        </div>
      </Show>
    </div>
  );
}
