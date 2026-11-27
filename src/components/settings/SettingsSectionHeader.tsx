import { BackIcon } from "./SettingsIcons.tsx";
import { useI18n } from "../../lib/i18n.tsx";
import { markBackHeaderOnScreen } from "../layout/routeChrome.ts";

interface SettingsSectionHeaderProps {
  title: string;
  onBack: () => void;
  accent?: "danger";
}

export function SettingsSectionHeader(props: SettingsSectionHeaderProps) {
  const { t } = useI18n();
  // A settings sub-screen keeps the /settings URL, so the phone's avatar bar
  // cannot tell from the route that this header already has back top-left.
  markBackHeaderOnScreen();
  const titleClass = () => (props.accent === "danger" ? "text-red-500" : "");

  return (
    <header class="sticky top-0 bg-neutral-900/80 backdrop-blur-sm border-b border-neutral-800 z-10">
      <div class="flex items-center gap-4 px-4 py-1.5">
        <button
          onClick={props.onBack}
          aria-label={t("common.back")}
          class="-ml-2 flex min-h-11 min-w-11 items-center justify-center rounded-full transition-colors hover:bg-neutral-800"
        >
          <BackIcon />
        </button>
        <h1 class={`text-xl font-bold ${titleClass()}`}>{props.title}</h1>
      </div>
    </header>
  );
}
