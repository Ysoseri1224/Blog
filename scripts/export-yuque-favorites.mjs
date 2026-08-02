import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

const require = createRequire("file:///D:/DevData/Temp/yuque-exporter-deps/package.json");
const cheerio = require("cheerio");
const sanitizeFilename = require("sanitize-filename");
const TurndownService = require("turndown");
const { gfm } = require("turndown-plugin-gfm");

const defaultInput = "D:/DevData/Temp/yuque-favorites-resolved.json";
const defaultArchiveDirectory = "D:/DevData/Temp/yuque-lakebooks";
const defaultOutput = path.resolve(".imports/yuque-favorites");
const inputPath = path.resolve(process.argv[2] ?? defaultInput);
const archiveDirectory = path.resolve(process.argv[3] ?? defaultArchiveDirectory);
const outputDirectory = path.resolve(process.argv[4] ?? defaultOutput);
const reuseDirectory = process.env.YUQUE_REUSE_DIRECTORY
  ? path.resolve(process.env.YUQUE_REUSE_DIRECTORY)
  : null;

const archiveNames = ["面试.lakebook", "Web学习.lakebook", "Write Up.lakebook"];
const contentTypes = new Map([
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"],
]);

function jsonScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function shanghaiDate(value) {
  if (!value) return "undated";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function safeName(value, fallback) {
  const normalized = sanitizeFilename(String(value ?? "").normalize("NFKC"), { replacement: "_" })
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, 100);
}

function canonicalDate(meta, archiveDoc) {
  return meta.firstPublishedAt
    ?? archiveDoc?.first_published_at
    ?? meta.publishedAt
    ?? archiveDoc?.published_at
    ?? meta.createdAt
    ?? archiveDoc?.created_at;
}

function summaryOf(meta, archiveDoc) {
  return archiveDoc?.custom_description?.trim()
    || archiveDoc?.description?.replace(/\s+/g, " ").trim()
    || "";
}

async function archiveDocuments() {
  const documents = new Map();
  const extractionRoot = await mkdtemp(path.join(tmpdir(), "yuque-lakebook-"));
  for (const archiveName of archiveNames) {
    const archivePath = path.join(archiveDirectory, archiveName);
    const archiveOutput = path.join(extractionRoot, safeName(archiveName, "archive"));
    await mkdir(archiveOutput, { recursive: true });
    execFileSync("tar", ["-xf", archivePath, "-C", archiveOutput], { stdio: "ignore" });
    const entries = await readdir(archiveOutput, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === "$meta.json" || !entry.name.endsWith(".json")) continue;
      const entryPath = path.join(entry.parentPath, entry.name);
      const wrapper = JSON.parse(await readFile(entryPath, "utf8"));
      if (!wrapper.doc?.id) continue;
      documents.set(String(wrapper.doc.id), {
        ...wrapper.doc,
        _archive: archiveName,
        _entry: path.relative(archiveOutput, entryPath).replaceAll("\\", "/"),
      });
    }
  }
  return { documents, extractionRoot };
}

function replaceElement($, element, tagName) {
  $(element).replaceWith(`<${tagName}>${$(element).html() ?? ""}</${tagName}>`);
}

function normalizeHtml(html, { shared, sourceUrl, issues }) {
  const $ = cheerio.load(html ?? "", { decodeEntities: false });
  $("script, style, button, svg, ne-heading-ext, ne-heading-anchor, ne-heading-fold, ne-list-fold, ne-uli-i, ne-hole, .ne-viewer-b-filler").remove();

  if (shared) {
    $("ne-card").each((index, element) => {
      const card = $(element);
      const cardName = card.attr("data-card-name") ?? "unknown";
      if (cardName === "image") {
        const image = card.find("img").first();
        card.replaceWith(image.length ? image : "");
      } else if (cardName === "hr") {
        card.replaceWith("<hr>");
      } else if (cardName === "codeblock" || cardName === "board") {
        const label = cardName === "codeblock" ? "代码块" : "画板";
        card.replaceWith(`<blockquote><p>语雀未向共享阅读页下发此${label}的源内容；请参阅原文：<a href="${sourceUrl}">${sourceUrl}</a></p></blockquote>`);
        issues.push(`shared_${cardName}_source_unavailable:${index + 1}`);
      } else {
        const text = card.text().trim();
        card.replaceWith(text ? `<p>${text}</p>` : "");
        issues.push(`shared_card_normalized:${cardName}`);
      }
    });

    for (const level of [1, 2, 3, 4]) {
      $(`ne-h${level}`).each((_, element) => replaceElement($, element, `h${level}`));
    }
    $("ne-quote").each((_, element) => replaceElement($, element, "blockquote"));
    $("ne-p").each((_, element) => replaceElement($, element, "p"));
    $("ne-code").each((_, element) => replaceElement($, element, "code"));
    $("ne-uli").each((_, element) => {
      const content = $(element).find("ne-uli-c").first();
      $(element).replaceWith(`<ul><li>${content.length ? content.html() : $(element).html()}</li></ul>`);
    });
    $("ne-heading-content, ne-code-content, ne-uli-c, ne-text, ne-table-box, ne-table-hole, ne-table-inner-wrap, ne-table-wrap")
      .each((_, element) => $(element).replaceWith($(element).html() ?? ""));
  }

  $("a").each((_, element) => {
    const anchor = $(element);
    if (!anchor.attr("href") && anchor.attr("data-href")) anchor.attr("href", anchor.attr("data-href"));
  });
  $("img").each((index, element) => {
    const image = $(element);
    const source = image.attr("src") || image.attr("data-src") || image.attr("data-original");
    if (source) image.attr("src", source);
    if (!image.attr("alt")) image.attr("alt", image.attr("title") || `图片 ${index + 1}`);
  });
  $("table").each((_, element) => {
    const table = $(element);
    table.find("th, td").each((__, cellElement) => {
      const cell = $(cellElement);
      cell.find("p, div").each((blockIndex, blockElement) => {
        const block = $(blockElement);
        block.replaceWith(`${blockIndex ? "<br>" : ""}${block.html() ?? ""}`);
      });
      cell.html((cell.html() ?? "").replace(/\s+/g, " ").trim());
    });
    if (table.children("thead").length) return;
    const firstRow = table.find("tr").first();
    if (!firstRow.length) return;
    const head = $("<thead></thead>");
    firstRow.remove();
    head.append(firstRow);
    table.prepend(head);
  });
  return $;
}

function turndown() {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
  });
  const defaultEscape = service.escape.bind(service);
  service.escape = (value) => defaultEscape(value)
    .replaceAll("<", "\\<")
    .replaceAll("$", "\\$");
  service.use(gfm);
  service.addRule("yuqueCode", {
    filter: (node) => node.nodeName === "PRE",
    replacement(content, node) {
      const language = node.getAttribute("data-language") || node.querySelector("code")?.getAttribute("class")?.match(/language-([^\s]+)/)?.[1] || "";
      const code = node.textContent.replace(/^\n|\n$/g, "");
      return `\n\n\`\`\`${language === "plain" ? "" : language}\n${code}\n\`\`\`\n\n`;
    },
  });
  return service;
}

function extensionFromUrl(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(?:avif|gif|jpe?g|png|svg|webp)$/.test(extension)) return extension === ".jpeg" ? ".jpg" : extension;
  } catch { /* 无法解析的远程地址交由 Content-Type 判定格式。 */ }
  return "";
}

async function downloadImage(url, destinationBase, referer) {
  const response = await globalThis.fetch(url, {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("empty response");
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  let extension = extensionFromUrl(url) || contentTypes.get(contentType) || ".bin";
  let destination = `${destinationBase}${extension}`;
  if (extension === ".bmp") {
    await writeFile(destination, bytes);
    const converted = `${destinationBase}.png`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", destination, "-frames:v", "1", converted], { stdio: "ignore" });
    await unlink(destination);
    destination = converted;
    extension = ".png";
    bytes = await readFile(converted);
  }
  await writeFile(destination, bytes);
  return {
    destination,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: extension === ".png" && contentType === "image/bmp" ? "image/png" : contentType,
  };
}

async function reusableMediaIndex() {
  const index = new Map();
  if (!reuseDirectory) return index;
  const manifest = JSON.parse(await readFile(path.join(reuseDirectory, "manifest.json"), "utf8"));
  for (const document of manifest.documents ?? []) {
    for (const media of document.media ?? []) {
      if (media.status !== "downloaded" || !media.localPath) continue;
      index.set(`${document.id}\u0000${media.source}`, {
        ...media,
        sourcePath: path.join(reuseDirectory, media.localPath),
      });
    }
  }
  return index;
}

async function convertDocument(meta, archiveDoc, fileNames, reusableMedia) {
  const shared = !archiveDoc;
  const sourceUrl = meta.canonicalUrl || meta.url;
  const issues = [];
  const html = archiveDoc?.body || meta.bodyHtml || "";
  if (!html.trim()) issues.push("empty_source_body");
  const $ = normalizeHtml(html, { shared, sourceUrl, issues });
  const date = canonicalDate(meta, archiveDoc);
  const createdAt = meta.createdAt ?? archiveDoc?.created_at ?? date;
  const title = meta.title || archiveDoc?.title || "无标题";
  const datePrefix = shanghaiDate(createdAt);
  const baseFileName = `${datePrefix}__${safeName(title, "无标题")}`;
  let fileName = `${baseFileName}.md`;
  if (fileNames.has(fileName.toLocaleLowerCase())) fileName = `${baseFileName}__${meta.id}.md`;
  fileNames.add(fileName.toLocaleLowerCase());
  const documentKey = String(meta.id);
  const assetDirectory = path.join(outputDirectory, "assets", documentKey);
  await mkdir(assetDirectory, { recursive: true });

  const media = [];
  const sourceToLocal = new Map();
  for (const [index, element] of $("img").toArray().entries()) {
    const image = $(element);
    const source = image.attr("src")?.trim();
    if (!source || source.startsWith("data:")) continue;
    if (sourceToLocal.has(source)) {
      image.attr("src", sourceToLocal.get(source));
      continue;
    }
    const destinationBase = path.join(assetDirectory, String(index + 1).padStart(3, "0"));
    try {
      const cached = reusableMedia.get(`${documentKey}\u0000${source}`);
      let downloaded;
      if (cached) {
        const extension = path.extname(cached.localPath);
        const destination = `${destinationBase}${extension}`;
        await copyFile(cached.sourcePath, destination);
        const bytes = await readFile(destination);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== cached.sha256) throw new Error("reused media checksum mismatch");
        downloaded = {
          destination,
          bytes: bytes.length,
          sha256,
          contentType: cached.contentType,
        };
      } else {
        downloaded = await downloadImage(source, destinationBase, sourceUrl);
      }
      const relative = path.relative(outputDirectory, downloaded.destination).replaceAll("\\", "/");
      sourceToLocal.set(source, relative);
      image.attr("src", relative);
      media.push({ source, localPath: relative, ...downloaded, destination: undefined, status: "downloaded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`image_download_failed:${source}:${message}`);
      media.push({ source, localPath: null, status: "failed", error: message });
    }
  }

  let markdown = turndown().turndown($("body").html() ?? "");
  markdown = markdown.replace(/(\S)(!\[[^\]]*\]\([^)]+\))/g, "$1 $2");
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
  const frontmatter = [
    "---",
    `title: ${jsonScalar(title)}`,
    `slug: ${jsonScalar(meta.slug || archiveDoc?.slug || `yuque-${meta.id}`)}`,
    'language: "zh-CN"',
    `summary: ${jsonScalar(summaryOf(meta, archiveDoc))}`,
    `date: ${jsonScalar(date)}`,
    `yuque_source: ${jsonScalar(sourceUrl)}`,
    `yuque_document_id: ${jsonScalar(meta.id)}`,
    `yuque_created_at: ${jsonScalar(createdAt)}`,
    `yuque_updated_at: ${jsonScalar(meta.updatedAt ?? archiveDoc?.updated_at ?? "")}`,
    `yuque_book: ${jsonScalar(meta.bookName || "分享")}`,
    "---",
    "",
  ].join("\n");
  await writeFile(path.join(outputDirectory, fileName), `${frontmatter}${markdown}\n`, "utf8");
  return {
    id: String(meta.id),
    title,
    slug: meta.slug || archiveDoc?.slug,
    sourceUrl,
    sourceKind: shared ? "shared_rendered_html" : "lakebook_html",
    archive: archiveDoc?._archive ?? null,
    archiveEntry: archiveDoc?._entry ?? null,
    output: fileName,
    createdAt,
    firstPublishedAt: date,
    updatedAt: meta.updatedAt ?? archiveDoc?.updated_at ?? null,
    media,
    issues,
    markdownCharacters: markdown.length,
  };
}

async function main() {
  const favorites = JSON.parse(await readFile(inputPath, "utf8"));
  const { documents: archives, extractionRoot } = await archiveDocuments();
  const reusableMedia = await reusableMediaIndex();
  const missing = favorites.filter((item) => !archives.has(String(item.id)) && !item.bodyHtml);
  if (missing.length) throw new Error(`归档缺少收藏文档 ID：${missing.map((item) => item.id).join(", ")}`);

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(path.join(outputDirectory, "assets"), { recursive: true });
  const fileNames = new Set();
  const documents = [];
  for (const [index, meta] of favorites.entries()) {
    process.stdout.write(`[${index + 1}/${favorites.length}] ${meta.title}\n`);
    documents.push(await convertDocument(meta, archives.get(String(meta.id)), fileNames, reusableMedia));
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: inputPath,
    archiveDirectory,
    totalFavorites: favorites.length,
    archiveMatches: documents.filter((item) => item.sourceKind === "lakebook_html").length,
    renderedHtmlFallbacks: documents.filter((item) => item.sourceKind === "shared_rendered_html").length,
    markdownFiles: documents.length,
    downloadedMedia: documents.reduce((total, item) => total + item.media.filter((media) => media.status === "downloaded").length, 0),
    failedMedia: documents.reduce((total, item) => total + item.media.filter((media) => media.status === "failed").length, 0),
    documents,
  };
  await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(extractionRoot, { recursive: true, force: true });
  process.stdout.write(`完成：${documents.length} 篇 Markdown，${manifest.downloadedMedia} 个媒体文件，${manifest.failedMedia} 个下载失败。\n`);
}

await main();
