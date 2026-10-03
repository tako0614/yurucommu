import { Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useAtom, useAtomValue, useSetAtom } from "solid-jotai";
import { actorAtom } from "../../atoms/auth.ts";
import { postDraftWriteFailedAtom } from "../../atoms/post-draft.ts";
import { tAtom } from "../../atoms/i18n.ts";
import { createScopeOpenAtom } from "../../atoms/shell.ts";
import { PERSONAL_SCOPE } from "../../atoms/scope.ts";
import {
  closePostModalAtom,
  closeSubmittedPostModalAtom,
  recoverPostDraftAtom,
  saveRecoveryPostDraftAtom,
  hideRetainedPostModalAtom,
  postDraftNoticeAtom,
  postDraftRecoveryNeededAtom,
  createPostAtom,
  postContentAtom,
  postSummaryAtom,
  postSubmitErrorAtom,
  postVisibilityAtom,
  postingAtom,
  removeMediaAtom,
  setMediaAltAtom,
  showPostModalAtom,
  showScopeSwitcherAtom,
  uploadedMediaAtom,
  uploadErrorAtom,
  uploadingAtom,
  uploadSelectionsPendingAtom,
  uploadMediaAtom,
} from "../../atoms/timeline.ts";
import { TimelinePostModal } from "../timeline/TimelinePostModal.tsx";
import { ScopeSwitcherSheet } from "../scope/ScopeSwitcherSheet.tsx";
import { CreateScopeModal } from "../scope/CreateScopeModal.tsx";

// App-shell-level post composer. Opened by `showPostModalAtom` so the IG-like
// center "Create" affordance works from any route, binding the same composition
// atoms the timeline uses so a created post lands at the head of the feed.
//
// A post belongs to the INDIVIDUAL, not to a community: it always goes to your
// reach with the chosen public/unlisted/followers visibility. It is decoupled
// from the home view filter (`inhabitedScopeAtom`) — narrowing your VIEW to a
// community never silently re-aims where a post lands. (Deliberately scoping a
// post to one group is a separate, future affordance.)
export function GlobalPostComposer() {
  const t = useAtomValue(tAtom);
  const navigate = useNavigate();
  const actor = useAtomValue(actorAtom);
  const [showModal] = useAtom(showPostModalAtom);
  // Layout-level "create a community" modal, shared with the desktop Sidebar.
  const [createScopeOpen, setCreateScopeOpen] = useAtom(createScopeOpenAtom);

  const [postContent, setPostContent] = useAtom(postContentAtom);
  const [postSummary, setPostSummary] = useAtom(postSummaryAtom);
  const [postVisibility, setPostVisibility] = useAtom(postVisibilityAtom);
  const posting = useAtomValue(postingAtom);
  const draftRecoveryNeeded = useAtomValue(postDraftRecoveryNeededAtom);
  const explicitDraftNotice = useAtomValue(postDraftNoticeAtom);
  const draftWriteFailed = useAtomValue(postDraftWriteFailedAtom);
  const draftNotice = () =>
    explicitDraftNotice() ??
    (draftWriteFailed() ? t()("compose.draftSaveFailed") : null);
  const uploadedMedia = useAtomValue(uploadedMediaAtom);
  const uploading = useAtomValue(uploadingAtom);
  const [pendingSelections, setPendingSelections] = useAtom(
    uploadSelectionsPendingAtom,
  );
  const uploadsPending = () => uploading() || pendingSelections() > 0;
  const uploadError = useAtomValue(uploadErrorAtom);
  const submitError = useAtomValue(postSubmitErrorAtom);

  // The scope switcher is reachable from inside the composer to re-aim the
  // audience, and from the home header pill / scope rail. It is mounted once
  // here (the shell-level owner) and shared via showScopeSwitcherAtom so no
  // page owns a private duplicate.
  const [scopeSwitcherOpen, setScopeSwitcherOpen] = useAtom(
    showScopeSwitcherAtom,
  );

  const doCreatePost = useSetAtom(createPostAtom);
  const doUploadMedia = useSetAtom(uploadMediaAtom);
  const doRemoveMedia = useSetAtom(removeMediaAtom);
  const doSetMediaAlt = useSetAtom(setMediaAltAtom);
  const doClosePostModal = useSetAtom(closePostModalAtom);
  const doCloseSubmittedPostModal = useSetAtom(closeSubmittedPostModalAtom);
  const doRecoverPostDraft = useSetAtom(recoverPostDraftAtom);
  const doSaveRecoveryDraft = useSetAtom(saveRecoveryPostDraftAtom);
  const doHideRetainedPostModal = useSetAtom(hideRetainedPostModalAtom);

  const handleFileSelect = async (
    e: InputEvent & { currentTarget: HTMLInputElement },
  ) => {
    const input = e.currentTarget;
    if (posting() || uploadsPending() || draftRecoveryNeeded()) {
      input.value = "";
      return;
    }
    const files = input.files;
    if (!files || files.length === 0) return;
    setPendingSelections((count) => count + 1);
    try {
      for (const file of Array.from(files)) {
        await doUploadMedia(file);
      }
    } finally {
      input.value = "";
      setPendingSelections((count) => count - 1);
    }
  };

  const handlePost = (): Promise<boolean> => {
    // The post is yours, addressed to your reach with the chosen visibility —
    // never bound to a community by default.
    return doCreatePost({
      content: postContent(),
      summary: postSummary(),
      visibility: postVisibility(),
      community_ap_id: undefined,
    }).then((ok) => ok || false);
  };

  const handleClose = () => {
    doClosePostModal();
  };

  return (
    <Show when={actor()}>
      {(currentActor) => (
        <>
          <TimelinePostModal
            isOpen={showModal()}
            actor={currentActor()}
            scope={PERSONAL_SCOPE}
            postContent={postContent()}
            onPostContentChange={(value) => {
              if (!posting() && !draftRecoveryNeeded()) setPostContent(value);
            }}
            postSummary={postSummary()}
            onPostSummaryChange={(value) => {
              if (!posting() && !draftRecoveryNeeded()) setPostSummary(value);
            }}
            postVisibility={postVisibility()}
            onPostVisibilityChange={(value) => {
              if (!posting() && !draftRecoveryNeeded())
                setPostVisibility(value);
            }}
            placeholder={t()("posts.placeholder")}
            submitLabel={t()("posts.post")}
            submittingLabel={t()("posts.posting")}
            onClose={handleClose}
            onSubmitSuccess={doCloseSubmittedPostModal}
            draftNotice={draftNotice()}
            draftRecoveryNeeded={draftRecoveryNeeded()}
            onRecoverDraft={doRecoverPostDraft}
            onSaveRecoveryDraft={doSaveRecoveryDraft}
            onKeepDraftAndClose={doHideRetainedPostModal}
            onSubmit={handlePost}
            posting={posting()}
            onFileSelect={handleFileSelect}
            uploadedMedia={uploadedMedia()}
            onRemoveMedia={doRemoveMedia}
            onMediaAltChange={(index, alt) => doSetMediaAlt({ index, alt })}
            uploading={uploadsPending()}
            uploadError={uploadError()}
            submitError={submitError()}
          />
          {/* Home filter picker. Selecting a community writes the transient
              inhabitedScopeAtom, narrowing the home view to that community. The
              sheet is mounted at layout level here, so without these callbacks
              "Create a community" / "Discover" would fall back to /search. Wire
              them to the shared create modal and the discover surface. */}
          <ScopeSwitcherSheet
            open={scopeSwitcherOpen()}
            onClose={() => setScopeSwitcherOpen(false)}
            onCreate={() => setCreateScopeOpen(true)}
            onDiscover={() => navigate("/search")}
          />
          {/* Shared community composer. Driven by the layout-level atom so the
              desktop Sidebar's "create a community" button opens the same one. */}
          <CreateScopeModal
            open={createScopeOpen()}
            onClose={() => setCreateScopeOpen(false)}
          />
        </>
      )}
    </Show>
  );
}
