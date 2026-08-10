import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";

import {
  fetchStampPacks,
  type InstalledStamp,
  type InstalledStampPack,
  setStampFavorite,
  uninstallStampPack,
} from "../../lib/api/stamps.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { localizedStampText } from "./stamp-picker-model.ts";

interface StampPickerProps {
  open: boolean;
  language: string;
  onClose: () => void;
  onSelect: (stampId: string) => Promise<boolean>;
}

type PickerTab = "recent" | "favorites" | `pack:${string}`;

type PickerStamp = InstalledStamp & {
  pack: InstalledStampPack;
};

export function StampPicker(props: StampPickerProps) {
  const [packs, setPacks] = createSignal<InstalledStampPack[]>([]);
  const [activeTab, setActiveTab] = createSignal<PickerTab>("recent");
  const [loading, setLoading] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [sendingStampId, setSendingStampId] = createSignal<string | null>(null);
  const [updatingFavoriteId, setUpdatingFavoriteId] = createSignal<
    string | null
  >(null);
  const [copied, setCopied] = createSignal(false);
  const [removingPackId, setRemovingPackId] = createSignal<string | null>(null);
  const { t } = useI18n();
  let loadGeneration = 0;

  const loadPacks = async () => {
    const generation = ++loadGeneration;
    setLoading(true);
    setLoadFailed(false);
    try {
      const loaded = await fetchStampPacks();
      if (generation !== loadGeneration) return;
      setPacks(loaded);
      const tab = activeTab();
      if (
        tab.startsWith("pack:") &&
        !loaded.some((pack) => `pack:${pack.id}` === tab)
      ) {
        setActiveTab("recent");
      }
    } catch (error) {
      if (generation !== loadGeneration) return;
      console.error("Failed to load Stamp packs:", error);
      setLoadFailed(true);
    } finally {
      if (generation === loadGeneration) setLoading(false);
    }
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) void loadPacks();
        else loadGeneration += 1;
      },
    ),
  );

  const allStamps = createMemo<PickerStamp[]>(() =>
    packs().flatMap((pack) => pack.stamps.map((stamp) => ({ ...stamp, pack }))),
  );

  const selectedStamps = createMemo<PickerStamp[]>(() => {
    const tab = activeTab();
    if (tab === "recent") {
      return allStamps()
        .filter((stamp) => stamp.recent !== null)
        .sort((left, right) =>
          right.recent!.last_used_at.localeCompare(left.recent!.last_used_at),
        );
    }
    if (tab === "favorites") {
      return allStamps().filter((stamp) => stamp.favorite);
    }
    const packId = tab.slice("pack:".length);
    return allStamps().filter((stamp) => stamp.pack.id === packId);
  });

  const activePack = createMemo(() => {
    const tab = activeTab();
    if (!tab.startsWith("pack:")) return null;
    return packs().find((pack) => `pack:${pack.id}` === tab) ?? null;
  });

  const emptyLabel = () =>
    activeTab() === "recent"
      ? t("dm.stampNoRecent")
      : activeTab() === "favorites"
        ? t("dm.stampNoFavorites")
        : t("dm.stampNoPacks");

  const selectStamp = async (stamp: PickerStamp) => {
    if (
      sendingStampId() ||
      !stamp.pack.rights.includes("send") ||
      updatingFavoriteId() === stamp.id
    ) {
      return;
    }
    setSendingStampId(stamp.id);
    try {
      if (await props.onSelect(stamp.id)) props.onClose();
    } finally {
      setSendingStampId(null);
    }
  };

  const toggleFavorite = async (stamp: PickerStamp) => {
    if (updatingFavoriteId()) return;
    const favorite = !stamp.favorite;
    setUpdatingFavoriteId(stamp.id);
    setPacks((current) =>
      current.map((pack) => ({
        ...pack,
        stamps: pack.stamps.map((candidate) =>
          candidate.id === stamp.id ? { ...candidate, favorite } : candidate,
        ),
      })),
    );
    try {
      await setStampFavorite(stamp.id, favorite);
    } catch (error) {
      console.error("Failed to update Stamp favorite:", error);
      setPacks((current) =>
        current.map((pack) => ({
          ...pack,
          stamps: pack.stamps.map((candidate) =>
            candidate.id === stamp.id
              ? { ...candidate, favorite: !favorite }
              : candidate,
          ),
        })),
      );
    } finally {
      setUpdatingFavoriteId(null);
    }
  };

  const copyShareLink = async () => {
    const pack = activePack();
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(pack.share_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.error("Failed to copy Stamp pack link:", error);
    }
  };

  const removeActivePack = async () => {
    const pack = activePack();
    if (!pack || removingPackId()) return;
    setRemovingPackId(pack.id);
    try {
      await uninstallStampPack(pack.id);
      setPacks((current) => current.filter((item) => item.id !== pack.id));
      setActiveTab("recent");
    } catch (error) {
      console.error("Failed to remove Stamp pack:", error);
    } finally {
      setRemovingPackId(null);
    }
  };

  return (
    <Show when={props.open}>
      <section
        aria-label={t("dm.stamps")}
        class="mx-4 mb-2 overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl"
      >
        <div class="flex items-center gap-1 border-b border-neutral-800 px-2 py-2">
          <div class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            <PickerTabButton
              active={activeTab() === "recent"}
              label={t("dm.stampRecent")}
              onClick={() => setActiveTab("recent")}
            />
            <PickerTabButton
              active={activeTab() === "favorites"}
              label={t("dm.stampFavorites")}
              onClick={() => setActiveTab("favorites")}
            />
            <For each={packs()}>
              {(pack) => (
                <PickerTabButton
                  active={activeTab() === `pack:${pack.id}`}
                  label={localizedStampText(pack.name, props.language)}
                  onClick={() => setActiveTab(`pack:${pack.id}`)}
                />
              )}
            </For>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label={t("common.close")}
            class="rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white"
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-width="2"
                d="M6 6l12 12M18 6L6 18"
              />
            </svg>
          </button>
        </div>

        <Show when={activePack()}>
          {(pack) => (
            <div class="flex items-center justify-between border-b border-neutral-800/70 px-3 py-2 text-xs text-neutral-500">
              <span class="truncate">
                {localizedStampText(pack().name, props.language)} · v
                {pack().release.number}
              </span>
              <div class="ml-3 flex flex-shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={copyShareLink}
                  class="text-accent hover:underline"
                >
                  {copied() ? t("dm.stampLinkCopied") : t("dm.stampShare")}
                </button>
                <button
                  type="button"
                  onClick={() => void removeActivePack()}
                  disabled={removingPackId() !== null}
                  class="text-neutral-400 hover:text-white disabled:opacity-50"
                >
                  {removingPackId() === pack().id
                    ? t("dm.stampRemoving")
                    : t("dm.stampRemovePack")}
                </button>
              </div>
            </div>
          )}
        </Show>

        <div class="h-60 overflow-y-auto p-3">
          <Show
            when={!loading()}
            fallback={
              <div class="grid h-full place-items-center text-sm text-neutral-500">
                {t("common.loading")}
              </div>
            }
          >
            <Show
              when={!loadFailed()}
              fallback={
                <div class="grid h-full place-items-center gap-2 text-center text-sm text-neutral-400">
                  <span>{t("dm.stampLoadFailed")}</span>
                  <button
                    type="button"
                    onClick={loadPacks}
                    class="rounded-full bg-neutral-800 px-4 py-1.5 text-white hover:bg-neutral-700"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              }
            >
              <Show
                when={selectedStamps().length > 0}
                fallback={
                  <div class="grid h-full place-items-center text-sm text-neutral-500">
                    {emptyLabel()}
                  </div>
                }
              >
                <div class="grid grid-cols-4 gap-2 sm:grid-cols-5">
                  <For each={selectedStamps()}>
                    {(stamp) => {
                      const alt = () =>
                        localizedStampText(
                          stamp.revision.alt,
                          props.language,
                        ) || stamp.key;
                      const canSend = () => stamp.pack.rights.includes("send");
                      return (
                        <div class="group relative aspect-square rounded-xl bg-neutral-800/40">
                          <button
                            type="button"
                            onClick={() => void selectStamp(stamp)}
                            disabled={!canSend() || sendingStampId() !== null}
                            aria-label={alt()}
                            title={alt()}
                            class="h-full w-full rounded-xl p-2 transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <img
                              src={stamp.revision.asset.url}
                              alt={alt()}
                              loading="lazy"
                              class="h-full w-full object-contain"
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleFavorite(stamp)}
                            disabled={updatingFavoriteId() !== null}
                            aria-label={
                              stamp.favorite
                                ? t("dm.stampFavoriteRemove")
                                : t("dm.stampFavoriteAdd")
                            }
                            class={`absolute right-0.5 top-0.5 rounded-full p-1 text-sm leading-none shadow transition-colors ${
                              stamp.favorite
                                ? "bg-amber-400 text-neutral-950"
                                : "bg-neutral-950/75 text-neutral-300 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                            }`}
                          >
                            ★
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
      </section>
    </Show>
  );
}

function PickerTabButton(props: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        props.active
          ? "bg-white text-neutral-950"
          : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
      }`}
    >
      {props.label}
    </button>
  );
}
