// Real-browser qualification for the feed, StoryBar, and own-profile journeys.
// The caller supplies a freshly authenticated owner browser and disposable
// native Worker bindings. This helper creates no actor/session fixtures.

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
  "base64",
);

function requireEffect(condition, message) {
  if (!condition) throw new Error(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readJson(response, label) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`${label} returned non-JSON: ${String(error)}`);
  }
  requireEffect(
    response.ok(),
    `${label} failed (${response.status()}): ${JSON.stringify(body)}`,
  );
  return body;
}

function expectResponse(page, pathname, method, label) {
  const pending = page
    .waitForResponse(
      (response) => {
        const request = response.request();
        return (
          new URL(response.url()).pathname === pathname &&
          request.method() === method
        );
      },
      { timeout: 20_000 },
    )
    .catch(async (error) => {
      const alert = await page
        .getByRole("alert")
        .allTextContents()
        .catch(() => []);
      throw new Error(
        `${label} produced no ${method} ${pathname} response within 20s; UI alerts=${JSON.stringify(alert)}; ${String(error)}`,
      );
    });
  // A picker/click can fail before the caller reaches its response await.
  // Mark that secondary rejection handled; awaiting pending still throws it.
  pending.catch(() => {});
  return pending;
}

async function chooseFile(page, trigger, file) {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await trigger.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

function payloadFile(request) {
  const contentType = request.headers()["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const body = request.postDataBuffer();
  requireEffect(
    boundary && body,
    "media upload request did not contain a multipart body",
  );
  const boundaryValue = (boundary[1] ?? boundary[2]).trim();
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  requireEffect(headerEnd >= 0, "media multipart file header was missing");
  const headers = body.subarray(0, headerEnd).toString("utf8");
  const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
  const partType = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1];
  const bytesStart = headerEnd + 4;
  const nextBoundary = body.indexOf(
    Buffer.from(`\r\n--${boundaryValue}`),
    bytesStart,
  );
  requireEffect(
    filename && partType && nextBoundary >= bytesStart,
    "media multipart file bytes could not be isolated",
  );
  return {
    filename,
    contentType: partType.trim(),
    bytes: body.subarray(bytesStart, nextBoundary),
  };
}

async function readBrowserMedia(page, url, credentials = "same-origin") {
  const result = await page.evaluate(
    async ({ path, credentials: mode }) => {
      const response = await fetch(path, { credentials: mode });
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        bytes,
      };
    },
    { path: url, credentials },
  );
  return { ...result, bytes: Buffer.from(result.bytes) };
}

async function assertUpload(db, media, upload, actorApId, bytes, contentType) {
  requireEffect(
    typeof upload.id === "string" &&
      upload.url ===
        `/media/${upload.id}.${contentType === "image/png" ? "png" : "jpg"}` &&
      upload.r2_key ===
        `uploads/${upload.id}.${contentType === "image/png" ? "png" : "jpg"}` &&
      upload.content_type === contentType,
    `media upload returned an unexpected product URL: ${JSON.stringify(upload)}`,
  );
  const row = await db
    .prepare(
      "SELECT uploader_ap_id, content_type, size, r2_key FROM media_uploads WHERE id = ?",
    )
    .bind(upload.id)
    .first();
  const blob = await media.get(upload.r2_key);
  requireEffect(
    row?.uploader_ap_id === actorApId &&
      row.content_type === contentType &&
      row.size === bytes.length &&
      row.r2_key === upload.r2_key &&
      blob &&
      Buffer.from(await blob.arrayBuffer()).equals(bytes),
    `media upload did not persist owner, MIME, size, and exact bytes: ${JSON.stringify(row)}`,
  );
  return row;
}

async function assertPublishedMediaReadback(
  page,
  url,
  bytes,
  contentType,
  label,
  privateOwnerCache = false,
) {
  const owner = await readBrowserMedia(page, url);
  const anonymous = await readBrowserMedia(page, url, "omit");
  for (const [scope, result] of [
    ["owner", owner],
    ["anonymous", anonymous],
  ]) {
    const cacheScope =
      scope === "owner" && privateOwnerCache ? "private" : "public";
    requireEffect(
      result.status === 200 &&
        result.contentType === contentType &&
        new RegExp(`^${cacheScope}, max-age=\\d+$`).test(
          result.cacheControl ?? "",
        ) &&
        result.bytes.equals(bytes),
      `${label} ${scope} HTTP media readback disagreed with R2 bytes or published policy: ${JSON.stringify({ status: result.status, contentType: result.contentType, cacheControl: result.cacheControl, byteLength: result.bytes.length, bytesMatch: result.bytes.equals(bytes) })}`,
    );
  }
}

async function assertDecodedImage(page, source, label) {
  await page
    .locator(`img[src=${JSON.stringify(source)}]:visible`)
    .first()
    .waitFor({
      state: "visible",
      timeout: 15_000,
    });
  await page.waitForFunction(
    (url) =>
      [...document.images].some(
        (image) =>
          image.getAttribute("src") === url &&
          image.getClientRects().length > 0 &&
          getComputedStyle(image).visibility !== "hidden" &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0,
      ),
    source,
    { timeout: 15_000 },
  );
  const dimensions = await page.evaluate((url) => {
    const image = [...document.images].find(
      (candidate) =>
        candidate.getAttribute("src") === url &&
        candidate.getClientRects().length > 0 &&
        getComputedStyle(candidate).visibility !== "hidden",
    );
    return image
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null;
  }, source);
  requireEffect(
    dimensions?.width > 0 && dimensions?.height > 0,
    `${label} was visible without a decoded image`,
  );
}

async function hasNoHorizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
}

export async function qualifyBrowserFeed({
  page,
  worker,
  db,
  origin,
  actorApId,
  checks,
}) {
  requireEffect(
    page && worker && db,
    "browser feed qualification needs page, Worker, and D1",
  );
  requireEffect(
    typeof actorApId === "string" && actorApId.startsWith(origin),
    "owner AP ID must belong to this artifact origin",
  );
  const media = await worker.getR2Bucket("MEDIA");
  await page.setViewportSize({ width: 1280, height: 900 });
  const actorBefore = await db
    .prepare(
      "SELECT preferred_username, name, icon_url FROM actors WHERE ap_id = ?",
    )
    .bind(actorApId)
    .first();
  requireEffect(
    actorBefore,
    "fresh authenticated owner row was absent from native D1",
  );
  const checksPassed = [];
  const mark = (value) => {
    checksPassed.push(value);
    checks.push(value);
  };

  const firstTimelinePromise = expectResponse(
    page,
    "/api/timeline",
    "GET",
    "fresh-owner initial timeline",
  );
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const firstTimeline = await readJson(
    await firstTimelinePromise,
    "fresh-owner initial timeline",
  );
  requireEffect(
    Array.isArray(firstTimeline.posts) && firstTimeline.posts.length === 0,
    `fresh password owner did not start with an empty feed: ${JSON.stringify(firstTimeline.posts)}`,
  );
  await page
    .getByRole("button", { name: "投稿", exact: true })
    .first()
    .waitFor({
      state: "visible",
      timeout: 15_000,
    });

  // Text-only public Note through the product composer.
  const textContent = `release-feed-text-${Date.now()}`;
  await page.getByRole("button", { name: "投稿", exact: true }).first().click();
  const postDialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await postDialog.waitFor({ state: "visible" });
  await postDialog.getByPlaceholder("今なにしてる？").fill(textContent);
  const textResponsePromise = expectResponse(
    page,
    "/api/posts",
    "POST",
    "text post",
  );
  await postDialog.getByRole("button", { name: "投稿", exact: true }).click();
  const textResponse = await textResponsePromise;
  const textBody = await readJson(textResponse, "browser text post");
  const textPost = textBody.post;
  requireEffect(
    textResponse.status() === 200 &&
      textPost?.type === "Note" &&
      textPost.author?.ap_id === actorApId &&
      textPost.content === textContent &&
      textPost.visibility === "public" &&
      Array.isArray(textPost.attachments) &&
      textPost.attachments.length === 0,
    `text post response did not describe the submitted public Note: ${JSON.stringify(textBody)}`,
  );
  const textSql = await db
    .prepare(
      `SELECT o.type, o.attributed_to, o.content, o.visibility, o.conversation,
        (SELECT COUNT(*) FROM activities a WHERE a.object_ap_id = o.ap_id
          AND a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound') AS create_count
       FROM objects o WHERE o.ap_id = ?`,
    )
    .bind(actorApId, textPost.ap_id)
    .first();
  requireEffect(
    textSql?.type === "Note" &&
      textSql.attributed_to === actorApId &&
      textSql.content === textContent &&
      textSql.visibility === "public" &&
      textSql.conversation === null &&
      textSql.create_count === 1,
    `text post D1 object/activity projection disagreed: ${JSON.stringify(textSql)}`,
  );
  await postDialog.waitFor({ state: "hidden" });
  await page
    .getByText(textContent, { exact: true })
    .waitFor({ state: "visible" });
  mark("browser-feed-public-text-post-200-sql-and-composer-reset");

  // Two files through the actual composer picker: an ASCII filename and the
  // Japanese filename that the locked API client currently rejects preflight.
  await page.getByRole("button", { name: "投稿", exact: true }).first().click();
  const attachmentDialog = page.getByRole("dialog", { name: "今なにしてる？" });
  await attachmentDialog.waitFor({ state: "visible" });
  requireEffect(
    (await attachmentDialog.getByPlaceholder("今なにしてる？").inputValue()) ===
      "",
    "successful text post left a stale composer draft",
  );
  const uploaded = [];
  for (const file of [
    { name: "ascii-feed.png", mimeType: "image/png", buffer: PNG },
    { name: "旅行.png", mimeType: "image/png", buffer: PNG },
  ]) {
    const responsePromise = expectResponse(
      page,
      "/api/media/upload",
      "POST",
      `upload ${file.name}`,
    );
    await chooseFile(
      page,
      attachmentDialog.getByRole("button", { name: "画像・動画を追加" }),
      file,
    );
    const response = await responsePromise;
    const body = await readJson(response, `browser upload ${file.name}`);
    const requestFile = payloadFile(response.request());
    requireEffect(
      response.status() === 200 &&
        /^[\w. -]+$/.test(requestFile.filename ?? "") &&
        requestFile.contentType === file.mimeType &&
        requestFile.bytes.equals(PNG),
      `browser did not submit the selected ${file.name} bytes unchanged`,
    );
    await assertUpload(db, media, body, actorApId, PNG, "image/png");
    uploaded.push({ ...body, filename: file.name, bytes: PNG });
  }
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="dialog"] img[src^="blob:"]')]
        .length === 2 &&
      [...document.querySelectorAll('[role="dialog"] img[src^="blob:"]')].every(
        (image) =>
          image.complete &&
          image.naturalWidth === 1 &&
          image.naturalHeight === 1,
      ),
    undefined,
    { timeout: 15_000 },
  );
  const altInputs = attachmentDialog.getByPlaceholder("画像の説明（任意）");
  await altInputs.nth(0).fill("ASCII fixture image");
  await altInputs.nth(1).fill("旅行の画像");
  const mediaContent = `release-feed-media-${Date.now()}`;
  await attachmentDialog.getByPlaceholder("今なにしてる？").fill(mediaContent);
  const mediaPostResponsePromise = expectResponse(
    page,
    "/api/posts",
    "POST",
    "post with selected images",
  );
  await attachmentDialog
    .getByRole("button", { name: "投稿", exact: true })
    .click();
  const mediaPostResponse = await mediaPostResponsePromise;
  const mediaPostBody = await readJson(mediaPostResponse, "browser image post");
  const mediaPost = mediaPostBody.post;
  const expectedAttachments = uploaded.map((file, index) => ({
    url: file.url,
    r2_key: file.r2_key,
    content_type: file.content_type,
    name: index === 0 ? "ASCII fixture image" : "旅行の画像",
  }));
  requireEffect(
    mediaPostResponse.status() === 200 &&
      mediaPost?.type === "Note" &&
      mediaPost.author?.ap_id === actorApId &&
      mediaPost.content === mediaContent &&
      mediaPost.visibility === "public" &&
      same(mediaPost.attachments, expectedAttachments),
    `image post response lost attachment order/identity: ${JSON.stringify(mediaPostBody)}`,
  );
  const mediaSql = await db
    .prepare(
      `SELECT o.type, o.attributed_to, o.content, o.visibility, o.attachments_json,
        (SELECT COUNT(*) FROM activities a WHERE a.object_ap_id = o.ap_id
          AND a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound') AS create_count
       FROM objects o WHERE o.ap_id = ?`,
    )
    .bind(actorApId, mediaPost.ap_id)
    .first();
  requireEffect(
    mediaSql?.type === "Note" &&
      mediaSql.attributed_to === actorApId &&
      mediaSql.content === mediaContent &&
      mediaSql.visibility === "public" &&
      same(JSON.parse(mediaSql.attachments_json), expectedAttachments) &&
      mediaSql.create_count === 1,
    `image post D1 object/activity projection disagreed: ${JSON.stringify(mediaSql)}`,
  );
  for (const file of uploaded) {
    await assertPublishedMediaReadback(
      page,
      file.url,
      file.bytes,
      "image/png",
      `published feed attachment ${file.filename}`,
      true, // Core deliberately uses private cache for the author of a public Note.
    );
  }
  await attachmentDialog.waitFor({ state: "hidden" });
  await page
    .getByText(mediaContent, { exact: true })
    .waitFor({ state: "visible" });
  mark(
    "browser-feed-ascii-and-unicode-image-uploads-public-post-and-r2-readback",
  );

  // A photo Story is composed in the real canvas. The selected Japanese name
  // is intentionally re-encoded by the product as generated story.jpg.
  await page.getByRole("button", { name: "ストーリーを追加" }).first().click();
  const storyDialog = page.getByRole("dialog", { name: "ストーリー作成" });
  await storyDialog.waitFor({ state: "visible" });
  await chooseFile(
    page,
    storyDialog.getByRole("button", { name: "写真を追加" }),
    { name: "旅行.png", mimeType: "image/png", buffer: PNG },
  );
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('[role="dialog"] canvas');
      if (
        !(canvas instanceof HTMLCanvasElement) ||
        !canvas.width ||
        !canvas.height
      )
        return false;
      const pixel = canvas
        .getContext("2d")
        ?.getImageData(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1,
        ).data;
      return (
        pixel &&
        Math.abs(pixel[0] - 16) <= 2 &&
        Math.abs(pixel[1] - 80) <= 2 &&
        Math.abs(pixel[2] - 200) <= 2 &&
        pixel[3] === 255
      );
    },
    undefined,
    { timeout: 15000 },
  );
  await storyDialog
    .getByRole("button", { name: "ストーリーズに投稿" })
    .waitFor({ state: "visible" });
  const storyCaption = `release-story-${Date.now()}`;
  await storyDialog
    .getByPlaceholder("キャプションを追加...")
    .fill(storyCaption);
  const [storyMediaResponse, storyResponse] = await Promise.all([
    expectResponse(
      page,
      "/api/media/upload",
      "POST",
      "rendered Story image upload",
    ),
    expectResponse(page, "/api/stories", "POST", "create Story"),
    storyDialog.getByRole("button", { name: "ストーリーズに投稿" }).click(),
  ]);
  const storyUpload = await readJson(
    storyMediaResponse,
    "rendered Story upload",
  );
  const renderedStoryFile = payloadFile(storyMediaResponse.request());
  requireEffect(
    storyMediaResponse.status() === 200 &&
      /^[\w. -]+$/.test(renderedStoryFile.filename ?? "") &&
      renderedStoryFile.contentType === "image/jpeg" &&
      renderedStoryFile.bytes.length > 0,
    "Story composer did not upload its rendered JPEG with an ASCII transport name",
  );
  await assertUpload(
    db,
    media,
    storyUpload,
    actorApId,
    renderedStoryFile.bytes,
    "image/jpeg",
  );
  const storyBody = await readJson(storyResponse, "browser Story create");
  const story = storyBody.story;
  requireEffect(
    storyResponse.status() === 201 &&
      typeof story?.ap_id === "string" &&
      story.author?.ap_id === actorApId &&
      story.caption === storyCaption &&
      story.attachment?.url === storyUpload.url &&
      story.attachment?.r2_key === storyUpload.r2_key &&
      story.attachment?.type === "Document" &&
      story.attachment?.mediaType === "image/jpeg" &&
      story.attachment?.width === 1080 &&
      story.attachment?.height === 1920 &&
      Date.parse(story.end_time) > Date.now(),
    `Story response did not preserve owner, rendered image, caption, and active expiry: ${JSON.stringify(storyBody)}`,
  );
  const storySql = await db
    .prepare(
      `SELECT o.type, o.attributed_to, o.attachments_json, o.end_time,
        (SELECT COUNT(*) FROM activities a WHERE a.object_ap_id = o.ap_id
          AND a.type = 'Create' AND a.actor_ap_id = ? AND a.direction = 'outbound') AS create_count
       FROM objects o WHERE o.ap_id = ?`,
    )
    .bind(actorApId, story.ap_id)
    .first();
  const storyData = JSON.parse(storySql?.attachments_json ?? "{}");
  const storyAttachment = storyData.attachment;
  requireEffect(
    storySql?.type === "Story" &&
      storySql.attributed_to === actorApId &&
      storyAttachment?.url === storyUpload.url &&
      storyAttachment?.r2_key === storyUpload.r2_key &&
      storyAttachment?.content_type === "image/jpeg" &&
      storyData.caption === storyCaption &&
      storySql.end_time === story.end_time &&
      Date.parse(storySql.end_time) > Date.now() &&
      storySql.create_count === 1,
    `Story D1 object/activity projection disagreed: ${JSON.stringify(storySql)}`,
  );
  const storyReadback = await readBrowserMedia(
    page,
    storyUpload.url,
    "same-origin",
  );
  requireEffect(
    storyReadback.status === 200 &&
      storyReadback.contentType === "image/jpeg" &&
      /^private, max-age=\d+$/.test(storyReadback.cacheControl ?? "") &&
      storyReadback.bytes.equals(renderedStoryFile.bytes),
    "owner Story media HTTP readback disagreed with the rendered upload/R2 bytes",
  );
  const anonymousStoryReadback = await readBrowserMedia(
    page,
    storyUpload.url,
    "omit",
  );
  const anonymousStoryBody = JSON.parse(
    anonymousStoryReadback.bytes.toString("utf8"),
  );
  requireEffect(
    anonymousStoryReadback.status === 403 &&
      anonymousStoryReadback.cacheControl === "no-store" &&
      anonymousStoryBody?.error === "Authentication required" &&
      Object.keys(anonymousStoryBody).length === 1,
    "anonymous Story media readback did not preserve the private-media boundary",
  );
  await storyDialog.waitFor({ state: "hidden" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "あなたのストーリーを見る" })
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("button", { name: "あなたのストーリーを見る" }).click();
  await assertDecodedImage(page, storyUpload.url, "own Story viewer");
  const storyImage = await page.evaluate((url) => {
    const image = [...document.images].find(
      (image) => image.getAttribute("src") === url,
    );
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixel: [...ctx.getImageData(540, 960, 1, 1).data],
    };
  }, storyUpload.url);
  requireEffect(
    storyImage?.width === 1080 &&
      storyImage?.height === 1920 &&
      Math.abs(storyImage.pixel[0] - 16) <= 5 &&
      Math.abs(storyImage.pixel[1] - 80) <= 5 &&
      Math.abs(storyImage.pixel[2] - 200) <= 5 &&
      storyImage.pixel[3] === 255,
    "reloaded Story JPEG lost the selected photo in its composition",
  );
  mark("browser-feed-story-photo-create-reload-viewer-and-native-readback");

  // Own-profile icon edit uses the same real upload route and then PUT /me.
  await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "プロフィールを編集" }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "プロフィールを編集" }).click();
  const profileDialog = page.getByRole("dialog", {
    name: "プロフィールを編集",
  });
  await profileDialog.waitFor({ state: "visible" });
  const profileUploadPromise = expectResponse(
    page,
    "/api/media/upload",
    "POST",
    "profile icon upload",
  );
  await chooseFile(
    page,
    profileDialog
      .locator('label:has(input[type="file"])')
      .filter({ hasText: "アイコンを変更" }),
    { name: "旅行.png", mimeType: "image/png", buffer: PNG },
  );
  const profileUploadResponse = await profileUploadPromise;
  const profileUpload = await readJson(
    profileUploadResponse,
    "browser profile icon upload",
  );
  const profileFile = payloadFile(profileUploadResponse.request());
  requireEffect(
    profileUploadResponse.status() === 200 &&
      /^[\w. -]+$/.test(profileFile.filename ?? "") &&
      profileFile.contentType === "image/png" &&
      profileFile.bytes.equals(PNG),
    "profile icon picker did not submit the selected Japanese-named PNG",
  );
  await assertUpload(db, media, profileUpload, actorApId, PNG, "image/png");
  const profileSavePromise = expectResponse(
    page,
    "/api/actors/me",
    "PUT",
    "profile save",
  );
  await profileDialog
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const profileSaveResponse = await profileSavePromise;
  const profileSaveBody = await readJson(
    profileSaveResponse,
    "browser profile save",
  );
  requireEffect(
    profileSaveResponse.status() === 200 && profileSaveBody.success === true,
    `profile save did not confirm success: ${JSON.stringify(profileSaveBody)}`,
  );
  const actorAfter = await db
    .prepare(
      "SELECT preferred_username, name, icon_url FROM actors WHERE ap_id = ?",
    )
    .bind(actorApId)
    .first();
  requireEffect(
    actorAfter?.preferred_username === actorBefore.preferred_username &&
      actorAfter.name === actorBefore.name &&
      actorAfter.icon_url === profileUpload.url,
    `profile icon update changed the wrong owner fields: ${JSON.stringify(actorAfter)}`,
  );
  await assertPublishedMediaReadback(
    page,
    profileUpload.url,
    PNG,
    "image/png",
    "profile icon",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await assertDecodedImage(
    page,
    profileUpload.url,
    "own profile icon after reload",
  );
  mark(
    "browser-feed-profile-icon-unicode-upload-put-me-sql-and-public-readback",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.getByText(textContent, { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.getByText(mediaContent, { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  requireEffect(
    await hasNoHorizontalOverflow(page),
    "populated mobile home has horizontal overflow at 390px",
  );
  await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "プロフィールを編集" }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  requireEffect(
    await hasNoHorizontalOverflow(page),
    "mobile own-profile view has horizontal overflow at 390px",
  );
  mark("browser-feed-and-own-profile-mobile-390-no-horizontal-overflow");

  return {
    ownerApId: actorApId,
    textPostApId: textPost.ap_id,
    imagePostApId: mediaPost.ap_id,
    storyApId: story.ap_id,
    uploadIds: [
      ...uploaded.map((item) => item.id),
      storyUpload.id,
      profileUpload.id,
    ],
    checkCount: checksPassed.length,
    checks: checksPassed,
  };
}
