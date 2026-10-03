import { expect, test } from "bun:test";
import { acknowledgesPost } from "./post-acknowledgement.ts";

const actor = "https://personal.example/ap/users/owner";
const post = {
  ap_id: "https://personal.example/ap/objects/accepted",
  type: "Note",
  content: "submitted draft",
  author: { ap_id: actor },
};

test("a complete response acknowledges the submitted Note and author", () => {
  expect(acknowledgesPost(post, actor, post.content)).toBe(true);
});

test("a truthy partial 200 post cannot establish an acknowledgement", () => {
  // The SDK accepts a partial result.post with an author object.
  for (const partial of [
    { author: { ap_id: actor } },
    { ...post, ap_id: undefined },
    { ...post, ap_id: "" },
    { ...post, ap_id: "not-an-absolute-id" },
    { ...post, ap_id: "javascript:alert(1)" },
    { ...post, author: undefined },
    null,
  ]) {
    expect(acknowledgesPost(partial, actor, post.content)).toBe(false);
  }
});

test("a different Note, author or missing submitter cannot acknowledge this draft", () => {
  expect(
    acknowledgesPost({ ...post, type: "Article" }, actor, post.content),
  ).toBe(false);
  expect(acknowledgesPost(post, actor, "a different draft")).toBe(false);
  expect(
    acknowledgesPost(
      post,
      "https://remote.example/ap/users/peer",
      post.content,
    ),
  ).toBe(false);
  expect(acknowledgesPost(post, undefined, post.content)).toBe(false);
});
