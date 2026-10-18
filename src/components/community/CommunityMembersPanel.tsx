import { createEffect, createSignal, For, on, Show } from "solid-js";
import { A } from "@solidjs/router";
import type { CommunityJoinRequest } from "../../lib/api.ts";
import type {
  CommunityInvite,
  CommunityMember,
} from "../../lib/api/communities.ts";
import { UserAvatar } from "../UserAvatar.tsx";
import { markComposeAside } from "../layout/routeChrome.ts";
import type { Translate } from "../../lib/i18n.tsx";

interface CommunityMembersPanelProps {
  members: CommunityMember[];
  joinRequests: CommunityJoinRequest[];
  canManage: boolean;
  isOwner: boolean;
  loadingRequests: boolean;
  requestAction: Record<string, boolean>;
  memberActionError: string | null;
  updatingMemberRole: Record<string, boolean>;
  inviteCode: string | null;
  creatingInvite: boolean;
  invites: CommunityInvite[];
  loadingInvites: boolean;
  revokingInvite: Record<string, boolean>;
  joinPolicy: string | undefined;
  actorApId: string;
  removingMember: Record<string, boolean>;
  onAcceptRequest: (request: CommunityJoinRequest) => void;
  onRejectRequest: (request: CommunityJoinRequest) => void;
  onUpdateMemberRole: (
    member: CommunityMember,
    role: "owner" | "moderator" | "member",
  ) => void;
  onRemoveMember: (member: CommunityMember) => void;
  onCreateInvite: () => void;
  onRevokeInvite: (invite: CommunityInvite) => void;
  t: Translate;
}

// Mounted only for a manager, whose rows carry a role selector and 削除 that the
// compose button covered on a phone.
function ComposeAside() {
  markComposeAside();
  return null;
}

export function CommunityMembersPanel(props: CommunityMembersPanelProps) {
  // The owner changes another member's role with a select in that row.
  const roleSelectShown = (member: CommunityMember) =>
    props.isOwner && member.ap_id !== props.actorApId;

  // Keyboard focus through a role change and a removal. A saved role
  // re-creates its row (a new member object), and a removal drops the row,
  // so the focused control went away and focus fell to <body>. Focus comes
  // back to the new row's select, or to the row now in the removed one's
  // place, but only if it is still nowhere.
  const focusIsLost = () => {
    const active = document.activeElement;
    return !active || active === document.body || !active.isConnected;
  };
  let refocusRoleFor: string | null = null;
  let refocusRowAt: number | null = null;
  createEffect(
    on(
      () => props.members.length,
      (length, previous) => {
        if (previous === undefined || length >= previous) return;
        const at = refocusRowAt;
        refocusRowAt = null;
        if (at === null || length === 0) return;
        queueMicrotask(() => {
          if (!focusIsLost()) return;
          document
            .querySelector<HTMLElement>(
              `[data-member-row="${Math.min(at, length - 1)}"] a`,
            )
            ?.focus();
        });
      },
    ),
  );
  // Brief "Copied" feedback after copying the freshly-created invite code, so the
  // owner doesn't have to hand-select the code text to share it.
  const [inviteCopied, setInviteCopied] = createSignal(false);
  const copyInvite = async () => {
    const code = props.inviteCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 1800);
    } catch {
      // Clipboard denied (insecure context / permissions) — leave the code
      // visible for manual selection.
    }
  };
  return (
    <div>
      <Show when={props.canManage}>
        <ComposeAside />
        <div class="border-b border-neutral-900">
          <div class="px-4 py-3">
            <div class="text-sm font-semibold text-neutral-400">
              {props.t("members.joinRequests")}
            </div>
          </div>
          <Show
            when={!props.loadingRequests}
            fallback={
              <div class="px-4 pb-4 text-sm text-neutral-500">
                {props.t("common.loading")}
              </div>
            }
          >
            <Show
              when={props.joinRequests.length > 0}
              fallback={
                <div class="px-4 pb-4 text-sm text-neutral-500">
                  {props.t("members.noPendingRequests")}
                </div>
              }
            >
              {/* 承認 / 拒否 are described by whose request they answer:
                  repeated per row, they did not say. */}
              <For each={props.joinRequests}>
                {(request, index) => (
                  <div class="flex items-center gap-3 px-4 py-3 border-t border-neutral-900">
                    <UserAvatar
                      avatarUrl={request.icon_url}
                      name={request.name || request.preferred_username}
                      size={40}
                      decorative
                    />
                    <div class="flex-1 min-w-0">
                      <div
                        id={`community-request-name-${index()}`}
                        class="font-semibold text-white truncate"
                      >
                        {request.name || request.preferred_username}
                      </div>
                      <div class="text-sm text-neutral-500 truncate">
                        @{request.username}
                      </div>
                    </div>
                    <div class="flex gap-2">
                      <button
                        aria-describedby={`community-request-name-${index()}`}
                        onClick={() => props.onAcceptRequest(request)}
                        disabled={props.requestAction[request.ap_id]}
                        class="px-3 py-1 text-xs bg-accent text-white rounded-full transition-colors disabled:opacity-50"
                      >
                        {props.t("dm.accept")}
                      </button>
                      <button
                        aria-describedby={`community-request-name-${index()}`}
                        onClick={() => props.onRejectRequest(request)}
                        disabled={props.requestAction[request.ap_id]}
                        class="px-3 py-1 text-xs bg-neutral-800 text-neutral-200 rounded-full hover:bg-neutral-700 transition-colors disabled:opacity-50"
                      >
                        {props.t("dm.reject")}
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={props.memberActionError}>
        <div class="px-4 py-2 text-sm text-red-400 bg-red-500/10">
          {props.memberActionError}
        </div>
      </Show>
      <Show
        when={props.members.length > 0}
        fallback={
          <div class="p-8 text-center text-neutral-500">
            {props.t("members.noMembers")}
          </div>
        }
      >
        {/* The row is not one link any more: the role select and 削除 sat
            inside the profile link (interactive content in <a> is invalid,
            and the link read 「Akari … Akari をコミュニティから削除しますか？」).
            The link is the avatar and name; the controls follow it. */}
        <For each={props.members}>
          {(member, index) => {
            const nameId = () => `community-member-name-${index()}`;
            // A marker set for this row is spent once its save or removal
            // settles without the row going away (a failed request), so it
            // cannot move focus later on some unrelated re-render. (A
            // cancelled owner promotion never starts a save and leaves the
            // role marker; it only acts while focus is lost, landing on this
            // member's select.)
            createEffect(
              on(
                () => props.updatingMemberRole[member.ap_id],
                (saving, wasSaving) => {
                  if (wasSaving && !saving && refocusRoleFor === member.ap_id)
                    queueMicrotask(() => {
                      if (refocusRoleFor === member.ap_id)
                        refocusRoleFor = null;
                    });
                },
              ),
            );
            createEffect(
              on(
                () => props.removingMember[member.ap_id],
                (removing, wasRemoving) => {
                  if (wasRemoving && !removing)
                    queueMicrotask(() => {
                      refocusRowAt = null;
                    });
                },
              ),
            );
            return (
              // The row's padding belongs to the link, so a tap on it still
              // opens the profile as it did when the whole row was the link.
              <div
                data-member-row={index()}
                class="flex items-center gap-3 pr-4 hover:bg-neutral-900/30 transition-colors"
              >
                <A
                  href={`/profile/${encodeURIComponent(member.ap_id)}`}
                  class="focus-inset flex min-w-0 flex-1 items-center gap-3 py-3 pl-4"
                >
                  {/* Decorative: the name follows as text, so the link
                      read the name twice. */}
                  <UserAvatar
                    avatarUrl={member.icon_url}
                    name={member.name || member.preferred_username}
                    size={48}
                    decorative
                  />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span id={nameId()} class="font-bold text-white truncate">
                        {member.name || member.preferred_username}
                      </span>
                      {/* One line, never squeezed into a column; left out
                          where the owner's role select already shows it. */}
                      <Show when={!roleSelectShown(member)}>
                        <Show when={member.role === "owner"}>
                          <span class="shrink-0 whitespace-nowrap px-1.5 py-0.5 text-xs bg-yellow-500/20 text-yellow-400 rounded">
                            {props.t("members.owner")}
                          </span>
                        </Show>
                        <Show when={member.role === "moderator"}>
                          <span class="shrink-0 whitespace-nowrap px-1.5 py-0.5 text-xs bg-accent-soft text-accent rounded">
                            {props.t("members.moderator")}
                          </span>
                        </Show>
                      </Show>
                    </div>
                    <div class="text-neutral-500 truncate">
                      @{member.username}
                    </div>
                  </div>
                </A>
                <Show when={roleSelectShown(member)}>
                  <select
                    ref={(el) => {
                      if (refocusRoleFor !== member.ap_id) return;
                      refocusRoleFor = null;
                      queueMicrotask(() => {
                        if (el.isConnected && focusIsLost()) el.focus();
                      });
                    }}
                    value={member.role}
                    aria-label={props
                      .t("members.changeRole")
                      .replace(
                        "{name}",
                        member.name || member.preferred_username,
                      )}
                    // The select shows the saved role: back to it at once,
                    // and to the new one when the row updates on success. A
                    // cancelled owner promotion or a failed save left the
                    // picked role showing, and the badge is not shown here.
                    // Not disabled while saving (that dropped keyboard focus to
                    // <body>): aria-disabled and dimmed, and a pick then is
                    // refused.
                    onChange={(e) => {
                      const next = e.currentTarget.value as
                        "owner" | "moderator" | "member";
                      e.currentTarget.value = member.role;
                      if (props.updatingMemberRole[member.ap_id]) return;
                      if (e.currentTarget.matches(":focus"))
                        refocusRoleFor = member.ap_id;
                      props.onUpdateMemberRole(member, next);
                    }}
                    aria-disabled={
                      props.updatingMemberRole[member.ap_id]
                        ? "true"
                        : undefined
                    }
                    // Dimmed by colour, not opacity, so the focus ring keeps
                    // its full strength while saving.
                    class={`shrink-0 bg-neutral-900 border text-xs rounded-lg px-2 py-1.5 ${
                      props.updatingMemberRole[member.ap_id]
                        ? "border-neutral-800 text-neutral-500"
                        : "border-neutral-700 text-white"
                    }`}
                  >
                    <option value="member">{props.t("members.member")}</option>
                    <option value="moderator">
                      {props.t("members.moderator")}
                    </option>
                    <option value="owner">{props.t("members.owner")}</option>
                  </select>
                </Show>
                {/* Remove (kick): an owner may remove anyone else; a moderator
                    only plain members — the backend refuses a moderator
                    removing a manager (403 "Owner role required to remove a
                    manager"), which the button used to offer. Never shown for
                    self (use leave). Named by its visible 削除, described by
                    the member's name (its name used to be the confirmation
                    question); a 32px tap target instead of 24x16. */}
                <Show
                  when={
                    props.canManage &&
                    member.ap_id !== props.actorApId &&
                    (props.isOwner || member.role === "member")
                  }
                >
                  <button
                    type="button"
                    aria-describedby={nameId()}
                    // Not disabled while removing, for the same reason as the
                    // select: the confirm hands focus back to it, and a
                    // disabled button dropped it to <body> (and kept it there
                    // on a failure). A press meanwhile is refused.
                    onClick={() => {
                      if (props.removingMember[member.ap_id]) return;
                      refocusRowAt = index();
                      props.onRemoveMember(member);
                    }}
                    aria-disabled={
                      props.removingMember[member.ap_id] ? "true" : undefined
                    }
                    class={`-my-1 -mr-2.5 shrink-0 rounded-lg px-2.5 py-2 text-xs ${
                      props.removingMember[member.ap_id]
                        ? "text-rose-400/50"
                        : "text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
                    }`}
                  >
                    {props.t("members.remove")}
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
      </Show>
      <Show when={props.canManage && props.joinPolicy === "invite"}>
        <div class="mt-4 p-3 bg-neutral-900/50 rounded-lg">
          <div class="text-sm font-semibold text-neutral-300 mb-2">
            {props.t("members.inviteCode")}
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <button
              onClick={props.onCreateInvite}
              disabled={props.creatingInvite}
              class="px-3 py-1 text-xs bg-accent text-white rounded-full transition-colors disabled:opacity-50"
            >
              {props.creatingInvite
                ? props.t("members.creatingInvite")
                : props.t("members.createInvite")}
            </button>
            <Show when={props.inviteCode}>
              <span class="px-2 py-1 text-xs bg-neutral-800 text-neutral-200 rounded font-mono">
                {props.inviteCode}
              </span>
              <button
                onClick={copyInvite}
                aria-label={props.t("members.copyInvite")}
                class="px-3 py-1 text-xs bg-neutral-800 text-neutral-200 rounded-full hover:bg-neutral-700 transition-colors"
              >
                {inviteCopied()
                  ? props.t("members.inviteCopied")
                  : props.t("members.copyInvite")}
              </button>
            </Show>
          </div>

          {/* Outstanding invites with their state + a revoke control, so a
              leaked/over-shared code can actually be invalidated from the app. */}
          <Show when={!props.loadingInvites} fallback={null}>
            <Show
              when={props.invites.length > 0}
              fallback={
                <div class="mt-3 text-xs text-neutral-500">
                  {props.t("members.noInvites")}
                </div>
              }
            >
              <div class="mt-3 space-y-2">
                <For each={props.invites}>
                  {(invite) => {
                    const used = () => invite.used_at !== null;
                    const expired = () =>
                      !used() &&
                      invite.expires_at !== null &&
                      invite.expires_at <= new Date().toISOString();
                    return (
                      <div class="flex items-center gap-2 text-xs">
                        <span class="font-mono text-neutral-300 truncate">
                          {invite.id}
                        </span>
                        <span
                          class="px-1.5 py-0.5 rounded"
                          classList={{
                            "bg-neutral-800 text-neutral-400":
                              used() || expired(),
                            "bg-green-500/15 text-green-400":
                              !used() && !expired(),
                          }}
                        >
                          {used()
                            ? props.t("members.inviteUsed")
                            : expired()
                              ? props.t("members.inviteExpired")
                              : props.t("members.inviteActive")}
                        </span>
                        <Show when={!used()}>
                          <button
                            type="button"
                            onClick={() => props.onRevokeInvite(invite)}
                            disabled={props.revokingInvite[invite.id]}
                            class="ml-auto text-rose-400 hover:text-rose-300 disabled:opacity-50 shrink-0"
                          >
                            {props.t("members.revokeInvite")}
                          </button>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
