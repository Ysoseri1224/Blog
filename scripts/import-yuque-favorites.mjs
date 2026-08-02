import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = process.env.BLOG_IMPORT_ORIGIN || "https://blog.ysoseri.us";
const password = process.env.BLOG_MANAGE_PASSWORD;
const importDirectory = path.resolve(process.argv[2] ?? ".imports/yuque-favorites");
const refreshExisting = process.argv.slice(3).includes("--refresh-existing");
const manifestPath = path.join(importDirectory, "manifest.json");
const statePath = path.join(importDirectory, "import-state.json");
const repositoryName = "技术内容";
const categoryName = "本科的一些学习笔记和wp";
const maxAttachmentPathsPerBatch = 90;
const maxDocumentsPerBatch = 4;
const renderArtifactThreshold = 20_000;
const renderChunkTarget = 4_000;

if (!password) throw new Error("缺少 BLOG_MANAGE_PASSWORD 环境变量");

const mimeTypes = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

let cookie = "";
let csrfToken = "";

async function parseResponse(response, label) {
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = body;
  }
  if (!response.ok) {
    const detail = typeof data === "object" && data ? JSON.stringify(data) : String(data);
    throw new Error(`${label} 失败：HTTP ${response.status} ${detail}`);
  }
  return data;
}

async function request(endpoint, options = {}) {
  const method = options.method ?? "GET";
  const headers = new globalThis.Headers(options.headers);
  headers.set("accept", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (!["GET", "HEAD"].includes(method)) {
    headers.set("origin", baseUrl);
    headers.set("x-csrf-token", csrfToken);
  }
  return globalThis.fetch(`${baseUrl}${endpoint}`, { ...options, method, headers });
}

async function jsonRequest(endpoint, method = "GET", body) {
  const headers = new globalThis.Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await request(endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response, `${method} ${endpoint}`);
}

async function login(state) {
  if (state.auth?.cookie && state.auth?.csrfToken) {
    cookie = state.auth.cookie;
    csrfToken = state.auth.csrfToken;
    const response = await request("/api/auth/session");
    if (response.ok) {
      const data = await parseResponse(response, "验证本地管理会话");
      if (data.authenticated) {
        process.stdout.write(`复用本地管理会话，有效至 ${data.expiresAt}\n`);
        return;
      }
    } else {
      await response.arrayBuffer();
    }
    cookie = "";
    csrfToken = "";
    delete state.auth;
    await saveState(state);
  }
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await globalThis.fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ password }),
    });
    if (response.status === 503 && attempt < 8) {
      process.stdout.write(`管理端登录遇到资源限制，退避重试 ${attempt}/7\n`);
      await response.arrayBuffer();
      await new Promise((resolve) => globalThis.setTimeout(resolve, attempt * 2_000));
      continue;
    }
    const data = await parseResponse(response, "登录博客管理端");
    const setCookie = response.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";", 1)[0] ?? "";
    csrfToken = data.csrfToken ?? "";
    if (!cookie || !csrfToken) throw new Error("登录响应缺少会话 Cookie 或 CSRF token");
    state.auth = { cookie, csrfToken, expiresAt: data.expiresAt };
    await saveState(state);
    process.stdout.write(`管理会话有效至 ${data.expiresAt}\n`);
    return;
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { categoryId: null, uploadedByHash: {}, importedPosts: {}, publishedPosts: {} };
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function attachmentCount(document) {
  return document.media?.length ?? 0;
}

function makeBatches(documents) {
  const batches = [];
  let batch = [];
  let references = 0;
  for (const document of documents) {
    const count = attachmentCount(document);
    if (count > maxAttachmentPathsPerBatch) {
      throw new Error(`单篇文档附件超过安全批次限制：${document.title} (${count})`);
    }
    if (batch.length && (references + count > maxAttachmentPathsPerBatch || batch.length >= maxDocumentsPerBatch)) {
      batches.push(batch);
      batch = [];
      references = 0;
    }
    batch.push(document);
    references += count;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function documentFingerprint(document) {
  const content = await readFile(path.join(importDirectory, document.output), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

async function ensureCategory(state) {
  const bootstrap = await jsonRequest("/api/manage/bootstrap");
  const repository = bootstrap.repositories.find((item) => item.name === repositoryName);
  if (!repository) throw new Error(`没有找到仓库：${repositoryName}`);
  const selected = await jsonRequest(`/api/manage/bootstrap?repository=${encodeURIComponent(repository.id)}`);
  const matches = selected.workspace.categories.filter((item) => item.name === categoryName && item.parentId === null);
  if (matches.length > 1) throw new Error(`存在多个同名根分类：${categoryName}`);
  let category = matches[0];
  if (!category) {
    const created = await jsonRequest("/api/manage/categories", "POST", {
      repositoryId: repository.id,
      parentId: null,
      name: categoryName,
    });
    category = created.category;
    process.stdout.write(`已创建分类：${categoryName}\n`);
  } else {
    process.stdout.write(`复用已有分类：${categoryName}\n`);
  }
  state.categoryId = category.id;
  await saveState(state);
  return { repository, category, workspace: selected.workspace };
}

async function reconcileImportedPosts(context, manifest, state) {
  const refreshed = await jsonRequest(`/api/manage/bootstrap?repository=${encodeURIComponent(context.repository.id)}`);
  const expectedBySlug = new Map(manifest.documents.map((document) => [document.slug, document]));
  const categoryPosts = refreshed.workspace.posts.filter((post) => post.categoryId === context.category.id);
  for (const post of categoryPosts) {
    const document = expectedBySlug.get(post.slug);
    if (!document || document.title !== post.title) {
      throw new Error(`目标分类存在无法归属本次迁移的文章：${post.title} (${post.slug})`);
    }
    const recorded = state.importedPosts[document.id];
    if (recorded && recorded !== post.id) throw new Error(`文档 ${document.title} 的线上 ID 与续跑状态冲突`);
    state.importedPosts[document.id] = post.id;
    if (post.status === "published") {
      state.publishedPosts[document.id] ??= {
        postId: post.id,
        slug: post.slug,
        firstPublishedAt: post.firstPublishedAt,
        lastPublishedAt: post.lastPublishedAt,
      };
    }
  }
  await saveState(state);
  return categoryPosts;
}

async function pruneMissingUploads(state) {
  let removed = 0;
  for (const [hash, assetId] of Object.entries(state.uploadedByHash)) {
    const response = await request(`/api/public/media/${assetId}`, { method: "HEAD" });
    if (response.status === 404) {
      delete state.uploadedByHash[hash];
      removed += 1;
    } else if (!response.ok) {
      throw new Error(`验证媒体资产失败：${assetId}，HTTP ${response.status}`);
    }
  }
  if (removed) process.stdout.write(`清理 ${removed} 个已失效媒体映射\n`);
  await saveState(state);
}

async function uploadMedia(media, batchId, state) {
  const existing = state.uploadedByHash[media.sha256];
  if (existing) return existing;
  const absolutePath = path.join(importDirectory, media.localPath);
  const bytes = await readFile(absolutePath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== media.sha256) throw new Error(`媒体哈希不一致：${media.localPath}`);
  const contentType = mimeTypes.get(path.extname(absolutePath).toLowerCase());
  if (!contentType) throw new Error(`媒体格式不受博客支持：${media.localPath}`);
  const response = await request("/api/manage/media", {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.length),
      "x-file-name": encodeURIComponent(path.basename(absolutePath)),
      "x-file-sha256": checksum,
      "x-import-batch-id": batchId,
    },
    body: bytes,
  });
  const data = await parseResponse(response, `上传 ${media.localPath}`);
  state.uploadedByHash[media.sha256] = data.asset.id;
  await saveState(state);
  return data.asset.id;
}

async function preview(repositoryId, categoryId, files, attachments) {
  return jsonRequest("/api/manage/import/preview", "POST", {
    repositoryId,
    categoryId,
    files,
    attachments,
  });
}

function verifyPreview(previewData, expectedCount, { resolved }) {
  if (previewData.items.length !== expectedCount) throw new Error(`预览文章数异常：${previewData.items.length}/${expectedCount}`);
  if (previewData.attachmentConflicts.length) throw new Error(`附件路径冲突：${JSON.stringify(previewData.attachmentConflicts)}`);
  for (const item of previewData.items) {
    if (item.missingAttachments.length) throw new Error(`${item.title} 缺失附件：${item.missingAttachments.join(", ")}`);
    if (item.slugConflict) throw new Error(`${item.title} 的 slug 已存在：${item.slug}`);
    if (item.duplicateCandidates.length) throw new Error(`${item.title} 存在重复候选：${JSON.stringify(item.duplicateCandidates)}`);
    if (!item.publishedTimeCandidate?.parsedAt || item.publishedTimeCandidate.issue) {
      throw new Error(`${item.title} 的首次发布时间无效：${JSON.stringify(item.publishedTimeCandidate)}`);
    }
    if (resolved && Object.keys(item.resolvedAttachments).length !== Object.keys(item.attachmentMatches).length) {
      throw new Error(`${item.title} 仍有未绑定媒体`);
    }
  }
}

async function importBatch(batch, batchIndex, context, manifest, state) {
  const pending = batch.filter((document) => !state.importedPosts[document.id]);
  if (!pending.length) {
    process.stdout.write(`批次 ${batchIndex} 已导入，跳过创建\n`);
    return;
  }
  if (pending.length !== batch.length) throw new Error(`批次 ${batchIndex} 存在部分导入状态，请先核对 import-state.json`);
  const batchId = randomUUID();
  const files = await Promise.all(pending.map(async (document) => ({
    path: document.output,
    content: await readFile(path.join(importDirectory, document.output), "utf8"),
  })));
  const mediaByPath = new Map(pending.flatMap((document) => document.media.map((media) => [media.localPath, media])));
  const attachmentPaths = [...mediaByPath.keys()];
  const initial = await preview(
    context.repository.id,
    context.category.id,
    files,
    attachmentPaths.map((mediaPath) => ({ path: mediaPath })),
  );
  verifyPreview(initial, pending.length, { resolved: false });
  process.stdout.write(`批次 ${batchIndex} 预览通过：${pending.length} 篇，${attachmentPaths.length} 个媒体引用\n`);

  const assetIds = new Map();
  let uploaded = 0;
  for (const mediaPath of attachmentPaths) {
    const media = mediaByPath.get(mediaPath);
    const assetId = await uploadMedia(media, batchId, state);
    assetIds.set(mediaPath, assetId);
    uploaded += 1;
    if (uploaded % 20 === 0 || uploaded === attachmentPaths.length) {
      process.stdout.write(`批次 ${batchIndex} 媒体绑定 ${uploaded}/${attachmentPaths.length}\n`);
    }
  }

  const resolved = await preview(
    context.repository.id,
    context.category.id,
    files,
    attachmentPaths.map((mediaPath) => ({ path: mediaPath, assetId: assetIds.get(mediaPath) })),
  );
  verifyPreview(resolved, pending.length, { resolved: true });
  let commit;
  try {
    commit = await jsonRequest("/api/manage/import/commit", "POST", {
      batchId,
      repositoryId: context.repository.id,
      categoryId: context.category.id,
      items: resolved.items.map((item) => ({
        ...item,
        action: "new",
        preserveFirstPublishedAt: item.publishedTimeCandidate.parsedAt,
      })),
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("1102")) throw error;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2_000));
    await reconcileImportedPosts(context, manifest, state);
    if (pending.every((document) => state.importedPosts[document.id])) {
      process.stdout.write(`批次 ${batchIndex} 已在线写入，资源上限仅影响响应；已完成对账\n`);
      return;
    }
    throw error;
  }
  if (commit.posts.length !== pending.length) throw new Error(`批次 ${batchIndex} 写入数量异常：${commit.posts.length}/${pending.length}`);
  for (const post of commit.posts) {
    const document = manifest.documents.find((item) => item.slug === post.slug);
    if (!document) throw new Error(`无法把导入文章映射回语雀文档：${post.slug}`);
    state.importedPosts[document.id] = post.id;
  }
  await saveState(state);
  process.stdout.write(`批次 ${batchIndex} 已写入 ${commit.posts.length} 篇草稿\n`);
}

function rewriteAttachments(markdown, resolvedAttachments) {
  let output = markdown;
  for (const [reference, assetId] of Object.entries(resolvedAttachments)) {
    output = output
      .replaceAll(`](${reference})`, `](media://${assetId})`)
      .replaceAll(`![[${reference}]]`, `![](media://${assetId})`);
  }
  return output;
}

function splitMarkdown(markdown) {
  const chunks = [];
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let current = "";
  let fence = null;
  const flush = () => {
    if (!current) return;
    chunks.push(current);
    current = "";
  };
  for (const line of lines) {
    if (!fence && current.length >= renderChunkTarget && /^#{1,6}\s/.test(line)) flush();
    current += line;
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match?.[1]) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
    }
    if (!fence && current.length >= renderChunkTarget && /^\s*$/.test(line)) flush();
    if (current.length > 40_000) throw new Error("单个 Markdown 结构块超过分片渲染上限");
  }
  flush();
  if (chunks.join("") !== markdown) throw new Error("Markdown 分片未保持原文");
  return chunks;
}

async function verifyRefreshPreview(previewData, batch, state) {
  if (previewData.items.length !== batch.length) {
    throw new Error(`刷新预览文章数异常：${previewData.items.length}/${batch.length}`);
  }
  if (previewData.attachmentConflicts.length) {
    throw new Error(`刷新附件路径冲突：${JSON.stringify(previewData.attachmentConflicts)}`);
  }
  const documentsByPath = new Map(batch.map((document) => [document.output.replaceAll("\\", "/"), document]));
  for (const item of previewData.items) {
    const document = documentsByPath.get(item.path);
    if (!document) throw new Error(`刷新预览出现未知文件：${item.path}`);
    const targetPostId = state.importedPosts[document.id];
    if (!targetPostId) throw new Error(`刷新目标文章不存在：${document.title}`);
    if (item.title !== document.title || item.slug !== document.slug) {
      throw new Error(`刷新预览元数据不一致：${document.title}`);
    }
    if (item.missingAttachments.length) {
      throw new Error(`${item.title} 缺失附件：${item.missingAttachments.join(", ")}`);
    }
    if (Object.keys(item.resolvedAttachments).length !== Object.keys(item.attachmentMatches).length) {
      throw new Error(`${item.title} 仍有未绑定媒体`);
    }
    if (!item.duplicateCandidates.some((candidate) => candidate.postId === targetPostId)) {
      throw new Error(`${item.title} 未匹配到既有文章 ${targetPostId}`);
    }
    if (!item.publishedTimeCandidate?.parsedAt || item.publishedTimeCandidate.issue) {
      throw new Error(`${item.title} 的首次发布时间无效：${JSON.stringify(item.publishedTimeCandidate)}`);
    }
    const resolvedMarkdown = rewriteAttachments(item.markdown, item.resolvedAttachments);
    let renderedHtml;
    if (resolvedMarkdown.length > renderArtifactThreshold) {
      item.renderedChunks = [];
      const chunks = splitMarkdown(resolvedMarkdown);
      for (const [index, source] of chunks.entries()) {
        process.stdout.write(`${item.title} 分片渲染 ${index + 1}/${chunks.length}\n`);
        const data = await jsonRequest("/api/manage/import/render-chunk", "POST", {
          source,
          prefix: `import-${String(index + 1).padStart(3, "0")}-`,
        });
        item.renderedChunks.push(data.chunk);
      }
      renderedHtml = item.renderedChunks.map((chunk) => chunk.result.html).join("\n");
    } else {
      const rendered = await jsonRequest("/api/manage/preview", "POST", { markdown: resolvedMarkdown });
      renderedHtml = String(rendered.html ?? "");
    }
    const renderedMedia = [...renderedHtml.matchAll(/<img\b/gi)].length;
    if (renderedMedia !== document.media.length) {
      throw new Error(`${item.title} 的预渲染媒体数量不一致：${renderedMedia}/${document.media.length}`);
    }
  }
}

async function refreshBatch(batch, batchIndex, context, state) {
  const batchId = randomUUID();
  const files = await Promise.all(batch.map(async (document) => ({
    path: document.output,
    content: await readFile(path.join(importDirectory, document.output), "utf8"),
  })));
  const mediaByPath = new Map(batch.flatMap((document) => document.media.map((media) => [media.localPath, media])));
  const attachments = [];
  let resolved = 0;
  for (const [mediaPath, media] of mediaByPath) {
    const assetId = await uploadMedia(media, batchId, state);
    attachments.push({ path: mediaPath, assetId });
    resolved += 1;
    if (resolved % 20 === 0 || resolved === mediaByPath.size) {
      process.stdout.write(`刷新批次 ${batchIndex} 媒体绑定 ${resolved}/${mediaByPath.size}\n`);
    }
  }
  const previewData = await preview(context.repository.id, context.category.id, files, attachments);
  await verifyRefreshPreview(previewData, batch, state);
  const documentsByPath = new Map(batch.map((document) => [document.output.replaceAll("\\", "/"), document]));
  const committed = await jsonRequest("/api/manage/import/commit", "POST", {
    batchId,
    repositoryId: context.repository.id,
    categoryId: context.category.id,
    items: previewData.items.map((item) => {
      const document = documentsByPath.get(item.path);
      return {
        ...item,
        action: "update",
        targetPostId: state.importedPosts[document.id],
        preserveFirstPublishedAt: item.publishedTimeCandidate.parsedAt,
      };
    }),
  });
  if (committed.posts.length !== batch.length) {
    throw new Error(`刷新写入数量异常：${committed.posts.length}/${batch.length}`);
  }
  state.refreshedPosts ??= {};
  for (const document of batch) {
    const targetPostId = state.importedPosts[document.id];
    if (!committed.posts.some((post) => post.id === targetPostId)) {
      throw new Error(`刷新响应缺少文章：${document.title}`);
    }
    state.refreshedPosts[document.id] = await documentFingerprint(document);
    delete state.publishedPosts[document.id];
  }
  await saveState(state);
  process.stdout.write(`刷新批次 ${batchIndex} 已更新 ${batch.length} 篇工作稿\n`);
}

async function publishPending(context, manifest, state) {
  const bootstrap = await jsonRequest(`/api/manage/bootstrap?repository=${encodeURIComponent(context.repository.id)}`);
  const onlinePosts = new Map(bootstrap.workspace.posts.map((post) => [post.id, post]));
  for (const [index, document] of manifest.documents.entries()) {
    const postId = state.importedPosts[document.id];
    if (!postId) throw new Error(`文档尚未导入：${document.title}`);
    const online = onlinePosts.get(postId);
    if (online?.status === "published" && online.publicRevision === online.revision) {
      state.publishedPosts[document.id] = {
        postId,
        slug: online.slug,
        firstPublishedAt: online.firstPublishedAt,
        lastPublishedAt: online.lastPublishedAt,
      };
      continue;
    }
    delete state.publishedPosts[document.id];
    let data;
    try {
      data = await jsonRequest(`/api/manage/posts/${postId}/publish`, "POST", {});
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("1102")) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2_000));
      const refreshed = await jsonRequest(`/api/manage/bootstrap?repository=${encodeURIComponent(context.repository.id)}`);
      const published = refreshed.workspace.posts.find((post) => (
        post.id === postId
        && post.status === "published"
        && post.publicRevision === post.revision
      ));
      if (!published) throw error;
      data = { post: published };
      process.stdout.write(`发布响应超限但线上状态已确认：${document.title}\n`);
    }
    if (data.post.status !== "published") throw new Error(`发布状态异常：${document.title}`);
    if (data.post.firstPublishedAt !== new Date(document.firstPublishedAt).toISOString()) {
      throw new Error(`首次发布时间未保留：${document.title}，期望 ${document.firstPublishedAt}，实际 ${data.post.firstPublishedAt}`);
    }
    state.publishedPosts[document.id] = {
      postId,
      slug: data.post.slug,
      firstPublishedAt: data.post.firstPublishedAt,
      lastPublishedAt: data.post.lastPublishedAt,
    };
    await saveState(state);
    process.stdout.write(`发布 ${index + 1}/${manifest.documents.length}：${document.title}\n`);
  }
}

async function verifyPublished(context, manifest, state) {
  const refreshed = await jsonRequest(`/api/manage/bootstrap?repository=${encodeURIComponent(context.repository.id)}`);
  const targetIds = new Set(Object.values(state.importedPosts));
  const posts = refreshed.workspace.posts.filter((post) => targetIds.has(post.id));
  if (posts.length !== manifest.documents.length) throw new Error(`线上文章数量异常：${posts.length}/${manifest.documents.length}`);
  const wrong = posts.filter((post) => post.status !== "published" || post.categoryId !== context.category.id);
  if (wrong.length) throw new Error(`线上文章状态或分类异常：${wrong.map((post) => post.title).join(", ")}`);
  const mediaIds = new Set();
  for (const document of manifest.documents) {
    const expectedDate = new Date(document.firstPublishedAt).toISOString();
    const summary = posts.find((post) => post.id === state.importedPosts[document.id]);
    if (summary?.firstPublishedAt !== expectedDate) {
      throw new Error(`线上首次发布时间不一致：${document.title}`);
    }
    const apiResponse = await globalThis.fetch(`${baseUrl}/api/public/post?repository=${encodeURIComponent(context.repository.key)}&slug=${encodeURIComponent(document.slug)}`);
    const publicPost = await parseResponse(apiResponse, `读取公开文章 ${document.title}`);
    if (publicPost.title !== document.title || publicPost.firstPublishedAt !== expectedDate) {
      throw new Error(`公开文章元数据不一致：${document.title}`);
    }
    const documentMedia = [...String(publicPost.html ?? "").matchAll(/\/api\/public\/media\/([0-9a-f-]{36})/gi)]
      .map((match) => match[1].toLowerCase());
    if (documentMedia.length !== document.media.length) {
      throw new Error(`公开文章媒体数量不一致：${document.title}，${documentMedia.length}/${document.media.length}`);
    }
    for (const assetId of documentMedia) mediaIds.add(assetId);
    const pageResponse = await globalThis.fetch(`${baseUrl}/${context.repository.key}/${document.slug}`, { redirect: "manual" });
    if (pageResponse.status !== 200) throw new Error(`公开文章不可访问：${document.title}，HTTP ${pageResponse.status}`);
  }
  const pendingMedia = [...mediaIds];
  const workers = Array.from({ length: Math.min(8, pendingMedia.length) }, async () => {
    while (pendingMedia.length) {
      const assetId = pendingMedia.pop();
      const response = await globalThis.fetch(`${baseUrl}/api/public/media/${assetId}`, { method: "HEAD" });
      if (response.status !== 200) throw new Error(`公开媒体不可访问：${assetId}，HTTP ${response.status}`);
    }
  });
  await Promise.all(workers);
  state.verifiedAt = new Date().toISOString();
  await saveState(state);
  process.stdout.write(`线上验证通过：${posts.length} 篇文章、${mediaIds.size} 个唯一媒体均可公开访问\n`);
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.markdownFiles !== 30 || manifest.failedMedia !== 0) throw new Error("本地导入 manifest 未通过前置条件");
  const state = await loadState();
  await login(state);
  const context = await ensureCategory(state);
  const existing = await reconcileImportedPosts(context, manifest, state);
  if (existing.length) process.stdout.write(`已从线上对账 ${existing.length} 篇现有文章\n`);
  if (refreshExisting) {
    const pendingRefresh = [];
    for (const document of manifest.documents) {
      const fingerprint = await documentFingerprint(document);
      if (state.refreshedPosts?.[document.id] !== fingerprint) pendingRefresh.push(document);
    }
    const refreshBatches = pendingRefresh.map((document) => [document]);
    process.stdout.write(`待刷新 ${pendingRefresh.length} 篇，计划 ${refreshBatches.length} 个更新批次\n`);
    for (const [index, batch] of refreshBatches.entries()) {
      await refreshBatch(batch, index + 1, context, state);
    }
  }
  const remaining = manifest.documents.filter((document) => !state.importedPosts[document.id]);
  if (remaining.length) await pruneMissingUploads(state);
  const batches = makeBatches(remaining);
  process.stdout.write(`剩余 ${remaining.length} 篇，计划 ${batches.length} 个导入批次\n`);
  for (const [index, batch] of batches.entries()) {
    await importBatch(batch, index + 1, context, manifest, state);
  }
  await publishPending(context, manifest, state);
  await verifyPublished(context, manifest, state);
}

await main();
