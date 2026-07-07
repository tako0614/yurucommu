import { atom } from "jotai/vanilla";
import type { ActorNote } from "../types/index.ts";
import { createNote, deleteMyNote, fetchNotes } from "../lib/api/notes.ts";
import { tAtom } from "./i18n.ts";
import { pushToast, toastWriter } from "./toast.ts";

export const actorNotesAtom = atom<ActorNote[]>([]);
export const notesLoadingAtom = atom(true);
export const notesErrorAtom = atom<string | null>(null);
export const noteSavingAtom = atom(false);

let notesLoadGen = 0;

export const loadNotesAtom = atom(null, async (get, set) => {
  const gen = ++notesLoadGen;
  set(notesErrorAtom, null);
  try {
    const data = await fetchNotes();
    if (gen !== notesLoadGen) return;
    set(actorNotesAtom, data);
  } catch (e) {
    if (gen !== notesLoadGen) return;
    console.error("Failed to load notes:", e);
    set(notesErrorAtom, get(tAtom)("notes.loadFailed"));
  } finally {
    if (gen === notesLoadGen) set(notesLoadingAtom, false);
  }
});

export const saveNoteAtom = atom(null, async (get, set, content: string) => {
  const trimmed = content.trim();
  if (!trimmed || get(noteSavingAtom)) return false;
  set(noteSavingAtom, true);
  try {
    const note = await createNote({ content: trimmed });
    set(actorNotesAtom, (prev) => [
      note,
      ...prev.filter((item) => item.actor.ap_id !== note.actor.ap_id),
    ]);
    pushToast(toastWriter(set), get(tAtom)("feedback.noteSaved"), {
      kind: "success",
    });
    return true;
  } catch (e) {
    console.error("Failed to save note:", e);
    pushToast(toastWriter(set), get(tAtom)("notes.saveFailed"), {
      kind: "error",
    });
    return false;
  } finally {
    set(noteSavingAtom, false);
  }
});

export const deleteMyNoteAtom = atom(null, async (get, set) => {
  if (get(noteSavingAtom)) return false;
  set(noteSavingAtom, true);
  try {
    await deleteMyNote();
    set(actorNotesAtom, (prev) => prev.filter((note) => !note.is_mine));
    pushToast(toastWriter(set), get(tAtom)("feedback.noteDeleted"), {
      kind: "success",
    });
    return true;
  } catch (e) {
    console.error("Failed to delete note:", e);
    pushToast(toastWriter(set), get(tAtom)("notes.deleteFailed"), {
      kind: "error",
    });
    return false;
  } finally {
    set(noteSavingAtom, false);
  }
});
