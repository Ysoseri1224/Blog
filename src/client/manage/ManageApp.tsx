import { diffLines } from "diff";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  Category,
  ManageBootstrap,
  PostDetail,
  PostSummary,
  Repository,
  RepositoryWorkspace,
} from "../../shared/types";
import { t } from "../../shared/i18n";
import { api, ApiError } from "../api";
import { Icon } from "../components/Icon";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import {
  bindingProblem,
  capturedBinding,
  commandDefinitions,
  loadShortcutOverrides,
  matchesKey,
  platformKey,
} from "./shortcuts";

type Section = "writing" | "media" | "repositories" | "security";
type SaveState =
  | "saved"
  | "local"
  | "saving"
  | "offline"
  | "error"
  | "conflict";
type Draft = Pick<
  PostDetail,
  | "title"
  | "slug"
  | "repositoryId"
  | "categoryId"
  | "language"
  | "summary"
  | "markdown"
  | "tags"
  | "featured"
  | "coverAssetId"
  | "customProperties"
>;
interface MediaAsset {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
  url: string;
}
interface MediaUpload {
  asset: MediaAsset;
  duplicate: boolean;
}
interface VersionItem {
  id: string;
  revision: number;
  kind: string;
  createdAt: string;
  permanent: boolean;
}
interface Command {
  id: string;
  title: string;
  category: string;
  keys: string[];
  run: () => void;
  enabled: () => boolean;
}
interface PublishedTimeCandidate {
  field: "date" | "published";
  raw: string;
  parsedAt: string | null;
  timezone: string | null;
  issue: string | null;
}
interface ImportItem {
  key: string;
  path: string;
  directory: string;
  title: string;
  slug: string;
  language: string;
  summary: string | null;
  tags: string[];
  coverAssetId: string | null;
  customProperties: Record<string, unknown>;
  markdown: string;
  missingAttachments: string[];
  resolvedAttachments: Record<string, string>;
  attachmentMatches: Record<string, string>;
  duplicateCandidates: Array<{ postId: string; title: string; reason: string }>;
  exportedPostId: string | null;
  exportSignature: string | null;
  exportedPostIdVerified: boolean;
  publishedTimeCandidate: PublishedTimeCandidate | null;
  slugConflict: boolean;
  action: "new" | "update" | "skip";
  targetPostId?: string;
  preserveFirstPublishedAt?: string | null;
}
interface ImportPreview {
  items: Omit<ImportItem, "action">[];
  ignored: string[];
  unreferencedAttachments: string[];
  attachmentConflicts: Array<{
    normalizedPath: string;
    paths: string[];
    reason: "case_collision" | "duplicate_path";
  }>;
}
interface LocalRecovery {
  draft: Draft;
  baseRevision: number;
  changed: boolean;
  conflicted: boolean;
}
interface ManageTab {
  postId: string;
  title: string;
}

function draftFromPost(post: PostDetail): Draft {
  return {
    title: post.title,
    slug: post.slug,
    repositoryId: post.repositoryId,
    categoryId: post.categoryId,
    language: post.language,
    summary: post.summary,
    markdown: post.markdown,
    tags: post.tags,
    featured: post.featured,
    coverAssetId: post.coverAssetId,
    customProperties: post.customProperties,
  };
}

function Dialog({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<Element | null>(null);
  useEffect(() => {
    previous.current = document.activeElement;
    const dialog = ref.current;
    const focusable = dialog?.querySelector<HTMLElement>(
      'button,input,textarea,select,[tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && dialog) {
        const all = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button,input,textarea,select,[tabindex]:not([tabindex="-1"])',
          ),
        ].filter((item) => !item.hasAttribute("disabled"));
        if (!all.length) return;
        const first = all[0],
          last = all.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      if (previous.current instanceof HTMLElement) previous.current.focus();
    };
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const labels: Record<SaveState, string> = {
    saved: "云端已保存",
    local: "本地已保存",
    saving: "正在同步",
    offline: "离线",
    error: "同步失败",
    conflict: "存在冲突",
  };
  return (
    <span className="save-indicator" data-state={state}>
      <i />
      {labels[state]}
    </span>
  );
}

export function ManageApp({ initial }: { initial: ManageBootstrap }) {
  const csrf = initial.csrfToken;
  const [initialRecovery] = useState<LocalRecovery | null>(() =>
    initial.activePost ? loadLocalRecovery(initial.activePost) : null,
  );
  const [section, setSection] = useState<Section>("writing");
  const [manageSidebarOpen, setManageSidebarOpen] = useState(false);
  const [manageSidebarCollapsed, setManageSidebarCollapsed] = useState(false);
  const [lang, setLang] = useState(initial.lang);
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const [repositories, setRepositories] = useState(initial.repositories);
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [post, setPost] = useState(initial.activePost);
  const [draft, setDraft] = useState<Draft | null>(
    initialRecovery?.draft ?? null,
  );
  const [mode, setMode] = useState<"live" | "source">("live");
  const [saveState, setSaveState] = useState<SaveState>(
    initialRecovery?.conflicted
      ? "conflict"
      : initialRecovery?.changed
        ? "local"
        : "saved",
  );
  const [dirty, setDirty] = useState(Boolean(initialRecovery?.changed));
  const [dialog, setDialog] = useState<
    | "preview"
    | "publish"
    | "history"
    | "help"
    | "media"
    | "schedule"
    | "conflict"
    | "categories"
    | "import"
    | null
  >(initialRecovery?.conflicted ? "conflict" : null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [propertiesOpen, setPropertiesOpen] = useState(
    () => matchMedia("(min-width: 801px)").matches,
  );
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [versionText, setVersionText] = useState("");
  const [compareText, setCompareText] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [compareVersion, setCompareVersion] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [shortcutOverrides, setShortcutOverrides] = useState<
    Record<string, string[]>
  >(loadShortcutOverrides);
  const [dangerAction, setDangerAction] = useState<
    "withdraw" | "delete" | null
  >(null);
  const [error, setError] = useState("");
  const [otherTab, setOtherTab] = useState(false);
  const [conflictPost, setConflictPost] = useState<PostDetail | null>(
    initialRecovery?.conflicted ? initial.activePost : null,
  );
  const [mergeText, setMergeText] = useState(
    initialRecovery?.conflicted ? initialRecovery.draft.markdown : "",
  );
  const [postQuery, setPostQuery] = useState("");
  const [manageTabs, setManageTabs] = useState<ManageTab[]>(
    initial.activePost
      ? [{ postId: initial.activePost.id, title: initial.activePost.title }]
      : [],
  );
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const postSearchRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const postRef = useRef(post);
  const saveNowRef = useRef<() => Promise<PostDetail | null>>(async () => null);
  const saveFlightRef = useRef<Promise<PostDetail | null> | null>(null);
  const pendingRef = useRef(false);
  const conflictRef = useRef(Boolean(initialRecovery?.conflicted));
  const localBaseRevisionRef = useRef<number | null>(
    initialRecovery?.baseRevision ?? initial.activePost?.revision ?? null,
  );
  const syncedDraftRef = useRef<string | null>(
    initial.activePost
      ? JSON.stringify(draftFromPost(initial.activePost))
      : null,
  );
  const composingRef = useRef(false);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    postRef.current = post;
  }, [post]);

  const refreshBootstrap = useCallback(
    async (repositoryId?: string, postId?: string) => {
      const query = new URLSearchParams();
      if (repositoryId) query.set("repository", repositoryId);
      if (postId) query.set("post", postId);
      const data = await api<ManageBootstrap>(
        `/api/manage/bootstrap?${query}`,
        {},
        csrf,
      );
      setRepositories(data.repositories);
      setWorkspace(data.workspace);
      if (postId) {
        const nextDraft = data.activePost
          ? draftFromPost(data.activePost)
          : null;
        postRef.current = data.activePost;
        draftRef.current = nextDraft;
        localBaseRevisionRef.current = data.activePost?.revision ?? null;
        syncedDraftRef.current = nextDraft ? JSON.stringify(nextDraft) : null;
        conflictRef.current = false;
        setConflictPost(null);
        setPost(data.activePost);
        setDraft(nextDraft);
      }
      return data;
    },
    [csrf],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("blog-theme", theme);
  }, [theme]);
  const activePostId = post?.id;
  const activeRevision = post?.revision;
  useEffect(() => {
    if (!activePostId) return;
    const channel = new BroadcastChannel("blog-editing");
    channel.onmessage = (
      event: MessageEvent<{ type: string; postId: string }>,
    ) => {
      if (event.data.postId !== activePostId) return;
      if (event.data.type === "query") {
        setOtherTab(true);
        channel.postMessage({ type: "presence", postId: activePostId });
      } else if (event.data.type === "presence") setOtherTab(true);
    };
    channel.postMessage({ type: "query", postId: activePostId });
    return () => channel.close();
  }, [activePostId]);

  const saveNow = useCallback(async (): Promise<PostDetail | null> => {
    if (conflictRef.current) return null;
    if (saveFlightRef.current) {
      pendingRef.current = true;
      return saveFlightRef.current;
    }
    const run = async (): Promise<PostDetail | null> => {
      while (true) {
        pendingRef.current = false;
        const currentPost = postRef.current,
          currentDraft = draftRef.current;
        if (
          !currentPost ||
          !currentDraft ||
          JSON.stringify(currentDraft) === syncedDraftRef.current
        )
          return currentPost;
        if (!navigator.onLine) {
          setSaveState("offline");
          return null;
        }
        setSaveState("saving");
        const captured = JSON.stringify(currentDraft);
        try {
          const data = await api<{ post: PostDetail }>(
            `/api/manage/posts/${currentPost.id}`,
            {
              method: "PUT",
              body: JSON.stringify({
                baseRevision: currentPost.revision,
                ...currentDraft,
              }),
            },
            csrf,
          );
          setPost(data.post);
          postRef.current = data.post;
          if (JSON.stringify(draftRef.current) === captured) {
            const serverDraft = draftFromPost(data.post);
            localBaseRevisionRef.current = data.post.revision;
            syncedDraftRef.current = JSON.stringify(serverDraft);
            draftRef.current = serverDraft;
            setDraft(serverDraft);
            setDirty(false);
            setSaveState("saved");
            localStorage.removeItem(`blog-draft:${data.post.id}`);
          } else {
            setSaveState("local");
            pendingRef.current = true;
          }
          if (!pendingRef.current) return data.post;
        } catch (reason) {
          if (
            reason instanceof ApiError &&
            reason.code === "revision_conflict"
          ) {
            conflictRef.current = true;
            localBaseRevisionRef.current = currentPost.revision;
            setSaveState("conflict");
            setMergeText(draftRef.current?.markdown ?? "");
            try {
              const latest = await api<{ post: PostDetail }>(
                `/api/manage/posts/${currentPost.id}`,
                {},
                csrf,
              );
              setConflictPost(latest.post);
            } catch (loadReason) {
              setError(
                loadReason instanceof Error
                  ? loadReason.message
                  : "无法读取云端版本",
              );
            }
            setDialog("conflict");
          } else setSaveState(navigator.onLine ? "error" : "offline");
          setError(reason instanceof Error ? reason.message : "同步失败");
          return null;
        }
      }
    };
    const flight = run();
    saveFlightRef.current = flight;
    try {
      return await flight;
    } finally {
      if (saveFlightRef.current === flight) saveFlightRef.current = null;
    }
  }, [csrf]);
  saveNowRef.current = saveNow;

  useEffect(() => {
    if (!activePostId || activeRevision === undefined || !draft) return;
    const serialized = JSON.stringify(draft);
    if (serialized === syncedDraftRef.current && !conflictRef.current) {
      setDirty(false);
      setSaveState("saved");
      localStorage.removeItem(`blog-draft:${activePostId}`);
      return;
    }
    const baseRevision = conflictRef.current
      ? (localBaseRevisionRef.current ?? activeRevision)
      : activeRevision;
    localStorage.setItem(
      `blog-draft:${activePostId}`,
      JSON.stringify({
        baseRevision,
        savedAt: new Date().toISOString(),
        draft,
      }),
    );
    setDirty(true);
    if (conflictRef.current) {
      setSaveState("conflict");
      return;
    }
    setSaveState(navigator.onLine ? "local" : "offline");
    const timer = setTimeout(() => void saveNowRef.current(), 1000);
    return () => clearTimeout(timer);
  }, [activePostId, activeRevision, draft]);
  useEffect(() => {
    if (!dirty) return;
    const timer = setInterval(() => void saveNow(), 10000);
    return () => clearInterval(timer);
  }, [dirty, saveNow]);
  useEffect(() => {
    const online = () => {
      if (dirty) void saveNow();
    };
    addEventListener("online", online);
    return () => removeEventListener("online", online);
  }, [dirty, saveNow]);

  const openPost = async (summary: PostSummary) => {
    await saveNow();
    const data = await api<{ post: PostDetail }>(
      `/api/manage/posts/${summary.id}`,
      {},
      csrf,
    );
    const serverDraft = draftFromPost(data.post);
    const recovery = loadLocalRecovery(data.post);
    postRef.current = data.post;
    draftRef.current = recovery.draft;
    localBaseRevisionRef.current = recovery.baseRevision;
    syncedDraftRef.current = JSON.stringify(serverDraft);
    conflictRef.current = recovery.conflicted;
    setConflictPost(recovery.conflicted ? data.post : null);
    setMergeText(recovery.conflicted ? recovery.draft.markdown : "");
    setPost(data.post);
    setDraft(recovery.draft);
    setManageTabs((current) =>
      current.some((tab) => tab.postId === data.post.id)
        ? current.map((tab) =>
            tab.postId === data.post.id
              ? { postId: data.post.id, title: data.post.title }
              : tab,
          )
        : [...current, { postId: data.post.id, title: data.post.title }],
    );
    setDirty(recovery.changed);
    setSaveState(
      recovery.conflicted ? "conflict" : recovery.changed ? "local" : "saved",
    );
    setDialog(recovery.conflicted ? "conflict" : null);
    history.pushState({}, "", `/manage/posts/${data.post.id}`);
    setOtherTab(false);
    setManageSidebarOpen(false);
  };
  const switchRepository = async (id: string) => {
    await saveNow();
    const data = await refreshBootstrap(id);
    postRef.current = null;
    draftRef.current = null;
    syncedDraftRef.current = null;
    conflictRef.current = false;
    setConflictPost(null);
    setPost(null);
    setDraft(null);
    setManageTabs([]);
    setPostQuery("");
    setManageSidebarOpen(false);
    if (data.workspace?.posts[0]) await openPost(data.workspace.posts[0]);
  };
  const newPost = async () => {
    if (!workspace) return;
    await saveNow();
    const data = await api<{ post: PostDetail }>(
      "/api/manage/posts",
      {
        method: "POST",
        body: JSON.stringify({
          repositoryId: workspace.repository.id,
          categoryId: null,
          title: "未命名",
          language: "zh-CN",
        }),
      },
      csrf,
    );
    await refreshBootstrap(workspace.repository.id, data.post.id);
    const serverDraft = draftFromPost(data.post);
    postRef.current = data.post;
    draftRef.current = serverDraft;
    syncedDraftRef.current = JSON.stringify(serverDraft);
    setPost(data.post);
    setDraft(serverDraft);
    setManageTabs((current) => [
      ...current.filter((tab) => tab.postId !== data.post.id),
      { postId: data.post.id, title: data.post.title },
    ]);
    history.pushState({}, "", `/manage/posts/${data.post.id}`);
    setTimeout(() => editorRef.current?.focus(), 0);
  };
  const updateDraft = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    if (typeof patch.title === "string" && post)
      setManageTabs((current) =>
        current.map((tab) =>
          tab.postId === post.id ? { ...tab, title: patch.title! } : tab,
        ),
      );
  };
  const showPreview = async () => {
    if (!draft) return;
    const data = await api<{ html: string }>(
      "/api/manage/preview",
      { method: "POST", body: JSON.stringify({ markdown: draft.markdown }) },
      csrf,
    );
    setPreviewHtml(data.html);
    setDialog("preview");
  };
  const publish = async () => {
    const saved = await saveNow();
    if (!saved) return;
    const data = await api<{ post: PostDetail }>(
      `/api/manage/posts/${saved.id}/publish`,
      { method: "POST" },
      csrf,
    );
    const serverDraft = draftFromPost(data.post);
    postRef.current = data.post;
    draftRef.current = serverDraft;
    syncedDraftRef.current = JSON.stringify(serverDraft);
    setPost(data.post);
    setDraft(serverDraft);
    setSaveState("saved");
    setDialog(null);
    await refreshBootstrap(data.post.repositoryId, data.post.id);
  };
  const requestPublish = async () => {
    if (conflictRef.current) {
      setDialog("conflict");
      return;
    }
    const saved = await saveNow();
    if (!saved) return;
    setDialog("publish");
  };
  const openHistory = async () => {
    const saved = await saveNow();
    if (!saved) return;
    const data = await api<{ versions: VersionItem[] }>(
      `/api/manage/posts/${saved.id}/versions`,
      {},
      csrf,
    );
    setVersions(data.versions);
    setDialog("history");
    if (data.versions[0]) void loadVersion(data.versions[0].id, "left");
    if (data.versions[1]) void loadVersion(data.versions[1].id, "right");
    else {
      setCompareVersion(null);
      setCompareText(draftRef.current?.markdown ?? "");
    }
  };
  const loadVersion = async (id: string, side: "left" | "right" = "left") => {
    if (!post) return;
    const data = await api<{ version: { markdown: string } }>(
      `/api/manage/posts/${post.id}/versions/${id}`,
      {},
      csrf,
    );
    if (side === "left") {
      setSelectedVersion(id);
      setVersionText(data.version.markdown);
    } else {
      setCompareVersion(id);
      setCompareText(data.version.markdown);
    }
  };
  const restore = async () => {
    if (!post || !selectedVersion) return;
    const data = await api<{ post: PostDetail }>(
      `/api/manage/posts/${post.id}/restore`,
      {
        method: "POST",
        body: JSON.stringify({
          versionId: selectedVersion,
          baseRevision: post.revision,
        }),
      },
      csrf,
    );
    const serverDraft = draftFromPost(data.post);
    postRef.current = data.post;
    draftRef.current = serverDraft;
    syncedDraftRef.current = JSON.stringify(serverDraft);
    setPost(data.post);
    setDraft(serverDraft);
    setDialog(null);
  };
  const loadMedia = async (query = "") => {
    const data = await api<{ assets: MediaAsset[] }>(
      `/api/manage/media?q=${encodeURIComponent(query)}`,
      {},
      csrf,
    );
    setMedia(data.assets);
  };
  const uploadDetailed = async (
    file: File,
    importBatchId?: string,
  ): Promise<MediaUpload> => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    const checksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const headers: Record<string, string> = {
      "content-type": file.type,
      "content-length": String(file.size),
      "x-file-name": encodeURIComponent(file.name),
      "x-file-sha256": checksum,
    };
    if (importBatchId) headers["x-import-batch-id"] = importBatchId;
    const data = await api<MediaUpload>(
      "/api/manage/media",
      { method: "PUT", body: file, headers },
      csrf,
    );
    await loadMedia();
    return data;
  };
  const upload = async (file: File) => (await uploadDetailed(file)).asset;
  const performDanger = async (
    action: "withdraw" | "delete",
    password: string,
  ) => {
    const saved = await saveNow();
    if (!saved) return;
    await api(
      "/api/auth/reauth",
      { method: "POST", body: JSON.stringify({ password }) },
      csrf,
    );
    if (action === "withdraw") {
      const data = await api<{ post: PostDetail }>(
        `/api/manage/posts/${saved.id}/withdraw`,
        { method: "POST" },
        csrf,
      );
      const serverDraft = draftFromPost(data.post);
      postRef.current = data.post;
      draftRef.current = serverDraft;
      syncedDraftRef.current = JSON.stringify(serverDraft);
      setPost(data.post);
      setDraft(serverDraft);
      await refreshBootstrap(data.post.repositoryId, data.post.id);
    } else {
      const repositoryId = saved.repositoryId;
      await api(`/api/manage/posts/${saved.id}`, { method: "DELETE" }, csrf);
      localStorage.removeItem(`blog-draft:${saved.id}`);
      postRef.current = null;
      draftRef.current = null;
      syncedDraftRef.current = null;
      setPost(null);
      setDraft(null);
      setManageTabs((current) =>
        current.filter((tab) => tab.postId !== saved.id),
      );
      history.pushState({}, "", `/manage`);
      await refreshBootstrap(repositoryId);
    }
    setDangerAction(null);
  };
  const refreshSettings = async () => {
    await saveNow();
    await refreshBootstrap();
    conflictRef.current = false;
    setConflictPost(null);
    syncedDraftRef.current = null;
    setPost(null);
    postRef.current = null;
    setDraft(null);
    draftRef.current = null;
    setManageTabs([]);
  };
  const refreshConflict = async () => {
    const current = postRef.current;
    if (!current) return;
    try {
      const latest = await api<{ post: PostDetail }>(
        `/api/manage/posts/${current.id}`,
        {},
        csrf,
      );
      setConflictPost(latest.post);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取云端版本");
    }
  };
  const resolveConflict = (choice: "cloud" | "local" | "merge") => {
    const latest = conflictPost,
      local = draftRef.current;
    if (!latest || !local) return;
    const serverDraft = draftFromPost(latest);
    postRef.current = latest;
    localBaseRevisionRef.current = latest.revision;
    syncedDraftRef.current = JSON.stringify(serverDraft);
    conflictRef.current = false;
    setPost(latest);
    setConflictPost(null);
    setDialog(null);
    if (choice === "cloud") {
      draftRef.current = serverDraft;
      setDraft(serverDraft);
      setDirty(false);
      setSaveState("saved");
      localStorage.removeItem(`blog-draft:${latest.id}`);
      return;
    }
    const nextDraft =
      choice === "merge" ? { ...local, markdown: mergeText } : local;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(true);
    setSaveState("local");
    setTimeout(() => void saveNowRef.current(), 0);
  };
  const leaveManagement = async (href: string) => {
    if (postRef.current && !(await saveNow())) return;
    location.assign(href);
  };
  const logoutNow = async () => {
    if (postRef.current && !(await saveNow())) return;
    await api("/api/auth/logout", { method: "POST" }, csrf);
    location.href = "/manage";
  };
  const toggleManageSidebar = () => {
    if (matchMedia("(max-width: 800px)").matches)
      setManageSidebarOpen((value) => !value);
    else setManageSidebarCollapsed((value) => !value);
  };
  const focusRepositorySearch = () => {
    setSection("writing");
    setManageSidebarCollapsed(false);
    setManageSidebarOpen(matchMedia("(max-width: 800px)").matches);
    setTimeout(() => postSearchRef.current?.focus(), 0);
  };
  const cycleManageTab = (direction: -1 | 1) => {
    if (manageTabs.length < 2) return;
    const index = Math.max(
      0,
      manageTabs.findIndex((tab) => tab.postId === post?.id),
    );
    const target =
      manageTabs[(index + direction + manageTabs.length) % manageTabs.length];
    const summary = workspace?.posts.find((item) => item.id === target?.postId);
    if (summary) void openPost(summary);
  };
  const closeManageTab = async (id: string) => {
    const index = manageTabs.findIndex((tab) => tab.postId === id);
    if (index < 0) return;
    const next = manageTabs.filter((tab) => tab.postId !== id);
    setManageTabs(next);
    if (post?.id !== id) return;
    const target = next[Math.min(index, next.length - 1)] ?? next.at(-1);
    if (target) {
      const summary = workspace?.posts.find(
        (item) => item.id === target.postId,
      );
      if (summary) {
        await openPost(summary);
        return;
      }
    }
    await saveNow();
    postRef.current = null;
    draftRef.current = null;
    setPost(null);
    setDraft(null);
    history.pushState({}, "", `/manage`);
  };

  const commandActions: Record<string, Pick<Command, "run" | "enabled">> = {
    save: {
      run: () => {
        if (conflictRef.current) setDialog("conflict");
        else void saveNow();
      },
      enabled: () => Boolean(post && draft),
    },
    "new-post": {
      run: () => void newPost(),
      enabled: () => Boolean(workspace),
    },
    "new-category": {
      run: () =>
        void saveNow().then((saved) => {
          if (!post || saved) setDialog("categories");
        }),
      enabled: () => Boolean(workspace),
    },
    preview: { run: () => void showPreview(), enabled: () => Boolean(draft) },
    "toggle-source": {
      run: () => setMode((value) => (value === "live" ? "source" : "live")),
      enabled: () => Boolean(draft),
    },
    publish: {
      run: () => void requestPublish(),
      enabled: () => Boolean(post && draft),
    },
    bold: {
      run: () => editorRef.current?.wrapSelection("**"),
      enabled: () => Boolean(draft),
    },
    italic: {
      run: () => editorRef.current?.wrapSelection("*"),
      enabled: () => Boolean(draft),
    },
    link: {
      run: () => editorRef.current?.wrapSelection("[", "](https://)"),
      enabled: () => Boolean(draft),
    },
    heading: {
      run: () => editorRef.current?.prefixLine("## "),
      enabled: () => Boolean(draft),
    },
    quote: {
      run: () => editorRef.current?.prefixLine("> "),
      enabled: () => Boolean(draft),
    },
    code: {
      run: () => editorRef.current?.wrapSelection("`"),
      enabled: () => Boolean(draft),
    },
    "bullet-list": {
      run: () => editorRef.current?.prefixLine("- "),
      enabled: () => Boolean(draft),
    },
    "numbered-list": {
      run: () => editorRef.current?.prefixLine("1. "),
      enabled: () => Boolean(draft),
    },
    "task-list": {
      run: () => editorRef.current?.prefixLine("- [ ] "),
      enabled: () => Boolean(draft),
    },
    indent: {
      run: () => editorRef.current?.indent(true),
      enabled: () => Boolean(draft),
    },
    outdent: {
      run: () => editorRef.current?.indent(false),
      enabled: () => Boolean(draft),
    },
    undo: {
      run: () => editorRef.current?.undo(),
      enabled: () => Boolean(draft),
    },
    redo: {
      run: () => editorRef.current?.redo(),
      enabled: () => Boolean(draft),
    },
    find: {
      run: () => editorRef.current?.openSearch(),
      enabled: () => Boolean(draft),
    },
    replace: {
      run: () => editorRef.current?.openSearch(true),
      enabled: () => Boolean(draft),
    },
    "select-structure": {
      run: () => editorRef.current?.selectStructure(),
      enabled: () => Boolean(draft),
    },
    history: { run: () => void openHistory(), enabled: () => Boolean(post) },
    "repository-search": {
      run: focusRepositorySearch,
      enabled: () => Boolean(workspace),
    },
    "previous-tab": {
      run: () => cycleManageTab(-1),
      enabled: () => manageTabs.length > 1,
    },
    "next-tab": {
      run: () => cycleManageTab(1),
      enabled: () => manageTabs.length > 1,
    },
    "close-tab": {
      run: () => {
        if (post) void closeManageTab(post.id);
      },
      enabled: () => Boolean(post),
    },
    "toggle-sidebar": { run: toggleManageSidebar, enabled: () => true },
    "toggle-properties": {
      run: () => setPropertiesOpen((value) => !value),
      enabled: () => Boolean(draft),
    },
    help: { run: () => setDialog("help"), enabled: () => true },
  };
  const commands: Command[] = commandDefinitions.map((definition) => ({
    ...definition,
    keys: shortcutOverrides[definition.id] ?? definition.defaultKeys,
    ...commandActions[definition.id]!,
  }));
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const setShortcut = (commandId: string, keys: string[] | null) =>
    setShortcutOverrides((current) => {
      const next = { ...current };
      if (keys) next[commandId] = keys;
      else delete next[commandId];
      localStorage.setItem("blog-shortcuts", JSON.stringify(next));
      return next;
    });
  const resetShortcuts = () => {
    localStorage.removeItem("blog-shortcuts");
    setShortcutOverrides({});
  };
  useEffect(() => {
    const start = () => {
      composingRef.current = true;
    };
    const end = () => {
      composingRef.current = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || composingRef.current)
        return;
      const command = commandsRef.current.find(
        (item) =>
          item.enabled() &&
          item.keys.some((binding) => matchesKey(event, binding)),
      );
      if (command) {
        event.preventDefault();
        command.run();
      }
    };
    addEventListener("compositionstart", start);
    addEventListener("compositionend", end);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("compositionstart", start);
      removeEventListener("compositionend", end);
      removeEventListener("keydown", key);
    };
  }, []);
  const normalizedPostQuery = postQuery.trim().toLocaleLowerCase();
  const visibleWorkspacePosts =
    workspace?.posts.filter(
      (item) =>
        !normalizedPostQuery ||
        `${item.title} ${item.summary ?? ""} ${item.tags.join(" ")}`
          .toLocaleLowerCase()
          .includes(normalizedPostQuery),
    ) ?? [];
  const publicRepository = post
    ? repositories.find((repository) => repository.id === post.repositoryId)
    : null;
  const publicPostHref = post
    && post.publicRevision !== null
    && post.status !== "withdrawn"
    && publicRepository
    && post.slug
    ? `/${publicRepository.key}/${post.slug}`
    : null;

  return (
    <div
      className="manage-shell"
      data-sidebar-collapsed={manageSidebarCollapsed || undefined}
    >
      <nav className="manage-rail">
        <a className="brand-mark" href="/" aria-label="返回博客" title="返回博客" onClick={(event) => { event.preventDefault(); void leaveManagement('/'); }}>
          <span className="brand-glyph" aria-hidden="true" />
        </a>
        <button
          className="icon-button"
          data-active={section === "writing" || undefined}
          title="写作"
          onClick={() => setSection("writing")}
        >
          <Icon name="edit" />
        </button>
        <button
          className="icon-button"
          data-active={section === "media" || undefined}
          title="媒体库"
          onClick={() => {
            setSection("media");
            void loadMedia();
          }}
        >
          <Icon name="media" />
        </button>
        <button
          className="icon-button"
          data-active={section === "repositories" || undefined}
          title="仓库设置"
          onClick={() => setSection("repositories")}
        >
          <Icon name="settings" />
        </button>
        <button
          className="icon-button"
          data-active={section === "security" || undefined}
          title="安全设置"
          onClick={() => setSection("security")}
        >
          <Icon name="lock" />
        </button>
        <div className="bottom-actions">
          <button
            className="icon-button"
            title="快捷键"
            onClick={() => commandById.get("help")?.run()}
          >
            <Icon name="help" />
          </button>
          <button
            className="icon-button"
            title="退出"
            onClick={() => void logoutNow()}
          >
            <Icon name="logout" />
          </button>
        </div>
      </nav>
      <header className="manage-header">
        <div className="manage-header-title">
          <button
            className="icon-button manage-menu"
            title="文章列表"
            onClick={() => commandById.get("toggle-sidebar")?.run()}
          >
            <Icon name="menu" />
          </button>
          <h1>
            {section === "writing"
              ? "写作"
              : section === "media"
                ? "媒体库"
                : section === "repositories"
                  ? "仓库设置"
                  : "安全设置"}
          </h1>
        </div>
        <div className="manage-header-actions">
          <button className="text-button manage-nav-button" title="返回博客" aria-label="返回博客" onClick={() => void leaveManagement('/')}>
            <Icon name="home" />
            <span>返回博客</span>
          </button>
          {publicPostHref && (
            <button className="text-button manage-nav-button" title="查看已发布文章" aria-label="查看已发布文章" onClick={() => void leaveManagement(publicPostHref)}>
              <Icon name="preview" />
              <span>查看已发布文章</span>
            </button>
          )}
          <button
            className="text-button"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Icon name="sun" /> : <Icon name="moon" />}
          </button>
        </div>
      </header>
      <aside
        className={`manage-sidebar ${manageSidebarOpen ? "mobile-open" : ""}`}
      >
        <div className="workspace-section">
          <div className="workspace-toolbar">
            <select
              value={workspace?.repository.id ?? ""}
              onChange={(event) => void switchRepository(event.target.value)}
            >
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              title="新建文章"
              onClick={() => commandById.get("new-post")?.run()}
            >
              <Icon name="file-plus" />
            </button>
            <button
              className="icon-button"
              title="管理分类"
              disabled={!workspace}
              onClick={() => commandById.get("new-category")?.run()}
            >
              <Icon name="folder-plus" />
            </button>
            <button
              className="icon-button"
              title="导入 Markdown、文件夹或 ZIP"
              disabled={!workspace}
              onClick={() =>
                void saveNow().then((saved) => {
                  if (!post || saved) setDialog("import");
                })
              }
            >
              <Icon name="upload" />
            </button>
          </div>
          <label className="manage-post-search">
            <Icon name="search" />
            <input
              ref={postSearchRef}
              type="search"
              value={postQuery}
              onChange={(event) => setPostQuery(event.target.value)}
              placeholder="搜索当前仓库"
            />
          </label>
          <div className="manage-post-list">
            {visibleWorkspacePosts.map((item) => (
              <button
                className="manage-post-row"
                data-active={item.id === post?.id || undefined}
                key={item.id}
                onClick={() => void openPost(item)}
              >
                <Icon name="file" />
                <span>{item.title}</span>
                <small className="status-chip" data-status={item.status}>
                  {item.status}
                </small>
              </button>
            ))}
            {normalizedPostQuery && !visibleWorkspacePosts.length && (
              <p className="panel-empty">没有匹配的文章。</p>
            )}
          </div>
        </div>
      </aside>
      {manageSidebarOpen && (
        <button
          className="manage-sidebar-scrim"
          aria-label="关闭文章列表"
          onClick={() => setManageSidebarOpen(false)}
        />
      )}
      <main className="manage-main">
        {section === "writing" && (
          <>
            {post && draft ? (
              <div className="editor-workspace">
                <nav className="manage-tabs" aria-label="打开的文章">
                  {manageTabs.map((tab) => (
                    <div
                      className="manage-tab"
                      data-active={tab.postId === post.id || undefined}
                      key={tab.postId}
                    >
                      <button
                        onClick={() => {
                          const target = workspace?.posts.find(
                            (item) => item.id === tab.postId,
                          );
                          if (target) void openPost(target);
                        }}
                      >
                        <Icon name="file" />
                        <span>{tab.title}</span>
                      </button>
                      <button
                        aria-label={`关闭 ${tab.title}`}
                        onClick={() => void closeManageTab(tab.postId)}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  ))}
                </nav>
                <div
                  className="editor-layout"
                  data-properties-open={propertiesOpen || undefined}
                >
                  <section className="editor-main">
                    <input
                      className="editor-title"
                      value={draft.title}
                      onChange={(event) =>
                        updateDraft({ title: event.target.value })
                      }
                      placeholder="未命名"
                    />
                    <div className="editor-modebar">
                      <div className="segmented">
                        <button
                          data-active={mode === "live" || undefined}
                          onClick={() => setMode("live")}
                        >
                          {t(lang, "live")}
                        </button>
                        <button
                          data-active={mode === "source" || undefined}
                          onClick={() => setMode("source")}
                        >
                          {t(lang, "source")}
                        </button>
                      </div>
                      <div className="editor-actions">
                        <button
                          className="icon-button"
                          title="插入媒体"
                          onClick={() => {
                            void loadMedia();
                            setDialog("media");
                          }}
                        >
                          <Icon name="image" />
                        </button>
                        <button
                          className="icon-button"
                          title="版本历史"
                          onClick={() => commandById.get("history")?.run()}
                        >
                          <Icon name="history" />
                        </button>
                        <button
                          className="icon-button"
                          title="导出带本站签名的 Markdown"
                          onClick={() => {
                            void saveNow().then((saved) => {
                              if (saved)
                                window.location.assign(
                                  `/api/manage/posts/${saved.id}/export`,
                                );
                            });
                          }}
                        >
                          <Icon name="file" />
                        </button>
                        <button
                          className="icon-button"
                          title="发布预览"
                          onClick={() => commandById.get("preview")?.run()}
                        >
                          <Icon name="preview" />
                        </button>
                        <button
                          className="icon-button"
                          data-active={propertiesOpen || undefined}
                          title="属性"
                          onClick={() => setPropertiesOpen(!propertiesOpen)}
                        >
                          <Icon name="properties" />
                        </button>
                        <button
                          className="secondary-button"
                          onClick={() => commandById.get("save")?.run()}
                        >
                          <Icon name="save" />
                          保存
                        </button>
                        <button
                          className="primary-button"
                          onClick={() => commandById.get("publish")?.run()}
                        >
                          <Icon name="publish" />
                          {post.publicRevision !== null ? "更新发布" : "发布"}
                        </button>
                        <button
                          className="icon-button"
                          title="定时发布"
                          onClick={() => setDialog("schedule")}
                        >
                          <Icon name="clock" />
                        </button>
                        {post.publicRevision !== null &&
                          post.status !== "withdrawn" && (
                            <button
                              className="text-button"
                              title="撤回公开文章"
                              onClick={() => setDangerAction("withdraw")}
                            >
                              撤回
                            </button>
                          )}
                        <button
                          className="icon-button"
                          title="永久删除文章"
                          onClick={() => setDangerAction("delete")}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </div>
                    <MarkdownEditor
                      key={post.id}
                      ref={editorRef}
                      value={draft.markdown}
                      mode={mode}
                      onChange={(markdown) => updateDraft({ markdown })}
                      onSave={() => commandById.get("save")?.run()}
                    />
                  </section>
                  <aside
                    className={`editor-properties ${propertiesOpen ? "mobile-open" : ""}`}
                  >
                    <h2>文章属性</h2>
                    <label className="field">
                      <span>URL slug</span>
                      <input
                        value={draft.slug}
                        onChange={(event) =>
                          updateDraft({
                            slug: event.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9-]/g, "-"),
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>仓库</span>
                      <select
                        value={draft.repositoryId}
                        onChange={(event) =>
                          updateDraft({
                            repositoryId: event.target.value,
                            categoryId: null,
                          })
                        }
                      >
                        {repositories.map((repository) => (
                          <option key={repository.id} value={repository.id}>
                            {repository.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>分类</span>
                      <select
                        value={draft.categoryId ?? ""}
                        onChange={(event) =>
                          updateDraft({
                            categoryId: event.target.value || null,
                          })
                        }
                      >
                        <option value="">仓库根目录</option>
                        {categoryOptions(workspace?.categories ?? []).map(
                          ({ category, depth }) => (
                            <option key={category.id} value={category.id}>
                              {"— ".repeat(depth)}
                              {category.name}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="field">
                      <span>原文语言</span>
                      <input
                        value={draft.language}
                        onChange={(event) =>
                          updateDraft({ language: event.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>摘要</span>
                      <textarea
                        value={draft.summary ?? ""}
                        onChange={(event) =>
                          updateDraft({ summary: event.target.value || null })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>标签（逗号分隔）</span>
                      <input
                        value={draft.tags.join(", ")}
                        onChange={(event) =>
                          updateDraft({
                            tags: event.target.value
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="toggle-field">
                      <span>精选文章</span>
                      <input
                        type="checkbox"
                        checked={draft.featured}
                        onChange={(event) =>
                          updateDraft({ featured: event.target.checked })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>文章封面</span>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          void loadMedia();
                          setDialog("media");
                        }}
                      >
                        {draft.coverAssetId ? "更换或移除封面" : "从媒体库选择"}
                      </button>
                      {draft.coverAssetId && (
                        <button
                          className="text-button"
                          onClick={() => updateDraft({ coverAssetId: null })}
                        >
                          移除封面
                        </button>
                      )}
                    </label>
                    <label className="field">
                      <span>自定义属性（JSON）</span>
                      <textarea
                        value={JSON.stringify(draft.customProperties, null, 2)}
                        onChange={(event) => {
                          try {
                            updateDraft({
                              customProperties: JSON.parse(
                                event.target.value,
                              ) as Record<string, unknown>,
                            });
                          } catch {
                            /* 保留上一个有效对象。 */
                          }
                        }}
                      />
                    </label>
                    <button
                      className="secondary-button"
                      onClick={() => setPropertiesOpen(false)}
                    >
                      收起属性
                    </button>
                  </aside>
                </div>
              </div>
            ) : (
              <div className="empty-reading">
                <Icon name="edit" />
                <h1>选择或新建一篇文章</h1>
              </div>
            )}
          </>
        )}
        {section === "media" && (
          <MediaLibrary
            assets={media}
            onUpload={upload}
            onRefresh={() => void loadMedia()}
            onSearch={(query) => void loadMedia(query)}
          />
        )}{" "}
        {section === "repositories" && (
          <RepositorySettings
            repositories={repositories}
            csrf={csrf}
            onChanged={() => void refreshSettings()}
          />
        )}{" "}
        {section === "security" && <AuthSettings csrf={csrf} />}
      </main>
      <footer className="manage-status">
        {otherTab && <span>另一个标签页也打开了这篇文章</span>}
        {post && (
          <>
            <span>{post.wordCount} 词</span>
            <span>{post.characterCount} 字符</span>
          </>
        )}
        <SaveIndicator state={saveState} />
      </footer>
      {dialog === "preview" && (
        <Dialog
          title="发布预览"
          className="preview-dialog"
          onClose={() => setDialog(null)}
        >
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => setDialog(null)}
            >
              返回编辑
            </button>
            <button className="primary-button" onClick={() => void publish()}>
              确认发布
            </button>
          </div>
        </Dialog>
      )}
      {dialog === "publish" && post && (
        <Dialog
          title={post.publicRevision !== null ? "更新公开版本" : "公开发布"}
          onClose={() => setDialog(null)}
        >
          <p>
            {post.publicRevision !== null
              ? "当前工作稿会生成一份新的不可变公开快照；操作完成前，访客继续读取旧版本。"
              : "工作稿会生成第一份公开快照，并出现在公开仓库、搜索、RSS 与 sitemap 中。"}
          </p>
          <p className="muted-note">
            普通保存仍只影响工作稿。公开后，已被 RSS
            阅读器下载的副本无法远程收回。
          </p>
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button className="primary-button" onClick={() => void publish()}>
              确认发布
            </button>
          </div>
        </Dialog>
      )}
      {dialog === "help" && (
        <ShortcutDialog
          commands={commands}
          onClose={() => setDialog(null)}
          onSet={setShortcut}
          onResetAll={resetShortcuts}
        />
      )}
      {dialog === "history" && (
        <Dialog
          title="版本历史"
          className="history-dialog"
          onClose={() => setDialog(null)}
        >
          <div className="history-controls">
            <label className="field">
              <span>左侧版本（可恢复）</span>
              <select
                value={selectedVersion ?? ""}
                onChange={(event) =>
                  void loadVersion(event.target.value, "left")
                }
              >
                {versions.map((version) => (
                  <option value={version.id} key={version.id}>
                    {version.kind} · r{version.revision} ·{" "}
                    {new Date(version.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>右侧版本</span>
              <select
                value={compareVersion ?? ""}
                onChange={(event) => {
                  if (event.target.value)
                    void loadVersion(event.target.value, "right");
                  else {
                    setCompareVersion(null);
                    setCompareText(draft?.markdown ?? "");
                  }
                }}
              >
                <option value="">当前工作稿</option>
                {versions.map((version) => (
                  <option value={version.id} key={version.id}>
                    {version.kind} · r{version.revision} ·{" "}
                    {new Date(version.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <div className="segmented">
              <button
                data-active={diffView === "unified" || undefined}
                onClick={() => setDiffView("unified")}
              >
                统一视图
              </button>
              <button
                data-active={diffView === "split" || undefined}
                onClick={() => setDiffView("split")}
              >
                并排视图
              </button>
            </div>
          </div>
          {diffView === "unified" ? (
            <div className="version-preview unified-diff">
              {diffLines(versionText, compareText).map((part, index) => (
                <span
                  className={
                    part.added ? "diff-add" : part.removed ? "diff-remove" : ""
                  }
                  key={index}
                >
                  {part.value}
                </span>
              ))}
            </div>
          ) : (
            <div className="split-diff">
              <pre>{versionText}</pre>
              <pre>{compareText}</pre>
            </div>
          )}
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() =>
                post &&
                void api(
                  `/api/manage/posts/${post.id}/versions`,
                  { method: "POST" },
                  csrf,
                ).then(() => openHistory())
              }
            >
              创建永久版本
            </button>
            <button
              className="primary-button"
              disabled={!selectedVersion}
              onClick={() => void restore()}
            >
              恢复左侧版本为新工作稿
            </button>
          </div>
        </Dialog>
      )}
      {dialog === "media" && (
        <Dialog title="插入媒体" onClose={() => setDialog(null)}>
          <MediaLibrary
            compact
            assets={media}
            onUpload={upload}
            onRefresh={() => void loadMedia()}
            onSearch={(query) => void loadMedia(query)}
            onSelect={(asset) => {
              editorRef.current?.insert(
                `\n![${asset.filename}](media://${asset.id})\n`,
              );
              setDialog(null);
            }}
            onCover={(asset) => {
              updateDraft({ coverAssetId: asset.id });
              setDialog(null);
            }}
          />
          <p>
            <a href="https://ysoseri.us/media">前往全站媒体库</a>
          </p>
        </Dialog>
      )}
      {dialog === "schedule" && post && (
        <ScheduleDialog
          timezone="Pacific/Auckland"
          onClose={() => setDialog(null)}
          onSubmit={async (localDateTime, timezone, utcDateTime) => {
            const saved = await saveNow();
            if (!saved) return;
            const data = await api<{ post: PostDetail }>(
              `/api/manage/posts/${saved.id}/schedule`,
              {
                method: "POST",
                body: JSON.stringify({
                  baseRevision: saved.revision,
                  localDateTime,
                  timezone,
                  utcDateTime,
                }),
              },
              csrf,
            );
            postRef.current = data.post;
            setPost(data.post);
            setDialog(null);
            await refreshBootstrap(data.post.repositoryId, data.post.id);
          }}
        />
      )}
      {dialog === "conflict" && post && draft && (
        <Dialog
          title="检测到编辑冲突"
          className="history-dialog"
          onClose={() => setDialog(null)}
        >
          <p>
            云端内容已在其他页面或设备更新。两份内容都仍保留；解决前不会发布，也不会用请求到达顺序覆盖任何一方。
          </p>
          {conflictPost ? (
            <>
              <div className="split-diff conflict-compare">
                <pre>
                  <strong>云端 · r{conflictPost.revision}</strong>
                  {"\n\n"}
                  {conflictPost.markdown}
                </pre>
                <pre>
                  <strong>本地工作稿</strong>
                  {"\n\n"}
                  {draft.markdown}
                </pre>
              </div>
              <div className="version-preview unified-diff">
                {diffLines(conflictPost.markdown, draft.markdown).map(
                  (part, index) => (
                    <span
                      className={
                        part.added
                          ? "diff-add"
                          : part.removed
                            ? "diff-remove"
                            : ""
                      }
                      key={index}
                    >
                      {part.value}
                    </span>
                  ),
                )}
              </div>
              <label className="field conflict-merge">
                <span>手动合并稿（其他文章属性沿用本地值）</span>
                <textarea
                  value={mergeText}
                  onChange={(event) => setMergeText(event.target.value)}
                />
              </label>
              <div className="dialog-actions conflict-actions">
                <button
                  className="text-button"
                  onClick={() =>
                    void navigator.clipboard.writeText(draft.markdown)
                  }
                >
                  复制本地稿
                </button>
                <button
                  className="secondary-button"
                  onClick={() => resolveConflict("cloud")}
                >
                  保留云端
                </button>
                <button
                  className="secondary-button"
                  onClick={() => resolveConflict("local")}
                >
                  保留本地并同步
                </button>
                <button
                  className="primary-button"
                  onClick={() => resolveConflict("merge")}
                >
                  使用合并稿并同步
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted-note">
                正在读取云端版本；本地稿已经保存在浏览器中。
              </p>
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  onClick={() => void refreshConflict()}
                >
                  重新读取云端
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
      {dialog === "categories" && workspace && (
        <CategoryDialog
          workspace={workspace}
          csrf={csrf}
          onClose={() => setDialog(null)}
          onChanged={() =>
            void refreshBootstrap(workspace.repository.id, post?.id)
          }
        />
      )}
      {dialog === "import" && workspace && (
        <ImportDialog
          repositoryId={workspace.repository.id}
          categoryId={draft?.categoryId ?? null}
          csrf={csrf}
          onUpload={uploadDetailed}
          onClose={() => setDialog(null)}
          onCommitted={async (posts) => {
            setDialog(null);
            await refreshBootstrap(workspace.repository.id, posts[0]?.id);
            if (posts[0]) {
              const serverDraft = draftFromPost(posts[0]);
              postRef.current = posts[0];
              draftRef.current = serverDraft;
              syncedDraftRef.current = JSON.stringify(serverDraft);
              setPost(posts[0]);
              setDraft(serverDraft);
              setManageTabs((current) => [
                ...current.filter((tab) => tab.postId !== posts[0]!.id),
                { postId: posts[0]!.id, title: posts[0]!.title },
              ]);
              history.pushState({}, "", `/manage/posts/${posts[0].id}`);
            }
          }}
        />
      )}
      {dangerAction && post && (
        <PostDangerDialog
          action={dangerAction}
          post={post}
          onClose={() => setDangerAction(null)}
          onConfirm={performDanger}
        />
      )}
      {error && (
        <div className="toast" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
    </div>
  );
}

function loadLocalRecovery(post: PostDetail): LocalRecovery {
  const serverDraft = draftFromPost(post);
  try {
    const local = JSON.parse(
      localStorage.getItem(`blog-draft:${post.id}`) ?? "null",
    ) as { baseRevision?: unknown; draft?: Partial<Draft> } | null;
    if (
      local &&
      typeof local.baseRevision === "number" &&
      local.draft &&
      typeof local.draft.title === "string" &&
      typeof local.draft.markdown === "string" &&
      Array.isArray(local.draft.tags)
    ) {
      const localDraft = local.draft as Draft;
      const changed =
        JSON.stringify(localDraft) !== JSON.stringify(serverDraft);
      return {
        draft: changed ? localDraft : serverDraft,
        baseRevision: changed ? local.baseRevision : post.revision,
        changed,
        conflicted: changed && local.baseRevision !== post.revision,
      };
    }
  } catch {
    /* 损坏的本地恢复副本不覆盖云端内容。 */
  }
  return {
    draft: serverDraft,
    baseRevision: post.revision,
    changed: false,
    conflicted: false,
  };
}

function ShortcutDialog({
  commands,
  onClose,
  onSet,
  onResetAll,
}: {
  commands: Command[];
  onClose: () => void;
  onSet: (commandId: string, keys: string[] | null) => void;
  onResetAll: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [candidate, setCandidate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = commands.filter(
    (command) =>
      !normalized ||
      `${command.title} ${command.category} ${command.keys.map((key) => platformKey(key)).join(" ")}`
        .toLocaleLowerCase()
        .includes(normalized),
  );
  const begin = (command: Command) => {
    setEditing(command.id);
    setCandidate(command.keys[0] ?? "");
    setProblem(null);
  };
  const capture = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    command: Command,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEditing(null);
      setProblem(null);
      return;
    }
    const value = capturedBinding(event.nativeEvent);
    if (!value) return;
    event.preventDefault();
    event.stopPropagation();
    setCandidate(value);
    setProblem(bindingProblem(value, command.id, commands));
  };
  const save = (command: Command) => {
    const issue = bindingProblem(candidate, command.id, commands);
    setProblem(issue);
    if (issue) return;
    onSet(command.id, [candidate]);
    setEditing(null);
  };
  return (
    <Dialog title="快捷键" className="shortcut-dialog" onClose={onClose}>
      <div className="shortcut-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索动作、分类或按键"
          aria-label="搜索快捷键"
        />
        <button
          className="secondary-button"
          onClick={() => {
            onResetAll();
            setEditing(null);
            setProblem(null);
          }}
        >
          全部恢复默认
        </button>
      </div>
      <div className="shortcut-list">
        {filtered.map((command) => (
          <div className="shortcut-row" key={command.id}>
            <span>
              <strong>{command.title}</strong>
              <small>{command.category}</small>
            </span>
            {editing === command.id ? (
              <div className="shortcut-editor">
                <input
                  readOnly
                  autoFocus
                  value={candidate ? platformKey(candidate) : ""}
                  placeholder="按下新组合键"
                  aria-label={`设置${command.title}快捷键`}
                  onKeyDown={(event) => capture(event, command)}
                />
                {problem && (
                  <small className="form-error" role="alert">
                    {problem}
                  </small>
                )}
                <div>
                  <button
                    className="text-button"
                    onClick={() => {
                      setEditing(null);
                      setProblem(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="primary-button"
                    disabled={!candidate || Boolean(problem)}
                    onClick={() => save(command)}
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <>
                <kbd>
                  {command.keys.map((key) => platformKey(key)).join(" / ")}
                </kbd>
                <div className="shortcut-actions">
                  <button
                    className="text-button"
                    onClick={() => begin(command)}
                  >
                    修改
                  </button>
                  <button
                    className="text-button"
                    onClick={() => onSet(command.id, null)}
                  >
                    恢复
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {!filtered.length && <p className="muted-note">没有匹配的命令。</p>}
      </div>
      <p className="muted-note">
        修改时直接按下组合键。浏览器保留键、与其他命令冲突的键，以及会干扰普通输入的裸字母不会保存。
      </p>
    </Dialog>
  );
}

function categoryOptions(
  categories: Category[],
): Array<{ category: Category; depth: number }> {
  const children = new Map<string | null, Category[]>();
  for (const category of categories)
    children.set(category.parentId, [
      ...(children.get(category.parentId) ?? []),
      category,
    ]);
  for (const list of children.values())
    list.sort((a, b) => a.name.localeCompare(b.name));
  const result: Array<{ category: Category; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const category of children.get(parent) ?? []) {
      if (seen.has(category.id)) continue;
      seen.add(category.id);
      result.push({ category, depth });
      visit(category.id, depth + 1);
    }
  };
  visit(null, 0);
  for (const category of categories)
    if (!seen.has(category.id)) result.push({ category, depth: 0 });
  return result;
}

function AuthSettings({ csrf }: { csrf: string | null }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid =
    currentPassword.length > 0 &&
    newPassword.length >= 10 &&
    newPassword === confirmPassword;
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/auth/password",
        {
          method: "PUT",
          body: JSON.stringify({ currentPassword, newPassword }),
        },
        csrf,
      );
      location.href = "/manage";
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法修改站内密码");
      setConfirming(false);
      setBusy(false);
    }
  };
  return (
    <section className="settings-page auth-settings">
      <h2>安全设置</h2>
      <p>
        Blog 管理页和全部作者 API
        共用同一个站内密码。修改后会撤销所有设备上的现有 30
        天会话，并要求使用新密码重新登录。
      </p>
      <div className="security-form">
        <label className="field">
          <span>当前站内密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setConfirming(false);
            }}
          />
        </label>
        <label className="field">
          <span>新密码（至少 10 个字符）</span>
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
              setConfirming(false);
            }}
          />
        </label>
        <label className="field">
          <span>再次输入新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              setConfirming(false);
            }}
          />
        </label>
        {confirmPassword && newPassword !== confirmPassword && (
          <p className="form-error">两次输入的新密码不一致。</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!confirming ? (
          <button
            className="danger-button"
            disabled={!valid || busy}
            onClick={() => setConfirming(true)}
          >
            修改站内密码
          </button>
        ) : (
          <div className="inline-danger">
            <strong>确认撤销全部作者会话？</strong>
            <p>
              保存新密码后，当前页面也会立即退出。这个操作不会修改文章、公开快照或媒体。
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                返回检查
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "正在更新…" : "确认修改并退出"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function MediaLibrary({
  assets,
  onUpload,
  onRefresh,
  onSearch,
  onSelect,
  onCover,
  compact = false,
}: {
  assets: MediaAsset[];
  onUpload: (file: File) => Promise<MediaAsset>;
  onRefresh: () => void;
  onSearch?: (query: string) => void;
  onSelect?: (asset: MediaAsset) => void;
  onCover?: (asset: MediaAsset) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const uploadFile = (file: File) => {
    setBusy(true);
    setError("");
    void onUpload(file)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "上传失败"),
      )
      .finally(() => setBusy(false));
  };
  return (
    <section className={compact ? "media-picker" : "settings-page"}>
      {!compact && (
        <>
          <h2>媒体库</h2>
          <p>
            这里用于上传、查找和复用全站共享媒体；大规模清理仍由独立媒体服务负责。
          </p>
        </>
      )}
      <div className="workspace-toolbar">
        <label className="primary-button">
          <Icon name="upload" />
          上传
          <input
            hidden
            type="file"
            accept="image/*,audio/*,video/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) uploadFile(file);
              event.target.value = "";
            }}
          />
        </label>
        {onSearch && (
          <input
            className="toolbar-search"
            type="search"
            value={query}
            placeholder="搜索媒体"
            onChange={(event) => {
              setQuery(event.target.value);
              onSearch(event.target.value);
            }}
          />
        )}
        <button className="secondary-button" onClick={onRefresh}>
          刷新
        </button>
        {busy && <span>正在上传…</span>}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="media-grid">
        {assets.map((asset) => (
          <article className="media-card" key={asset.id}>
            {asset.contentType.startsWith("image/") ? (
              <img src={asset.url} loading="lazy" alt="" />
            ) : (
              <div className="empty-reading">
                <Icon
                  name={
                    asset.contentType.startsWith("video/") ? "media" : "file"
                  }
                />
              </div>
            )}
            <span>{asset.filename}</span>
            <div className="media-card-actions">
              {onSelect && (
                <button className="text-button" onClick={() => onSelect(asset)}>
                  插入
                </button>
              )}
              {onCover && asset.contentType.startsWith("image/") && (
                <button className="text-button" onClick={() => onCover(asset)}>
                  设为封面
                </button>
              )}
              {!onSelect && !onCover && (
                <a
                  className="text-button"
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看
                </a>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RepositorySettings({
  repositories,
  csrf,
  onChanged,
}: {
  repositories: Repository[];
  csrf: string | null;
  onChanged: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState<Repository | "new" | null>(null);
  const [deleting, setDeleting] = useState<Repository | null>(null);
  return (
    <section className="settings-page">
      <h2>仓库设置</h2>
      <p>
        仓库是完整的内容空间。公开会进入主动发现出口；不列出允许持链接访问但不进入索引；私密只允许作者访问。
      </p>
      <button className="primary-button" onClick={() => setEditing("new")}>
        新增仓库
      </button>
      {repositories.map((repository) => (
        <article className="repository-card" key={repository.id}>
          <div>
            <h3>{repository.name}</h3>
            <p>
              /{repository.key}/ · {repository.visibility}
            </p>
          </div>
          <div className="repository-card-actions">
            <button
              className="secondary-button"
              onClick={() => setEditing(repository)}
            >
              编辑
            </button>
            <button
              className="danger-button"
              onClick={() => setDeleting(repository)}
            >
              删除
            </button>
          </div>
        </article>
      ))}
      {editing && (
        <RepositoryFormDialog
          repository={editing === "new" ? null : editing}
          csrf={csrf}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      )}
      {deleting && (
        <RepositoryDeleteDialog
          repository={deleting}
          repositories={repositories}
          csrf={csrf}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

function RepositoryFormDialog({
  repository,
  csrf,
  onClose,
  onSaved,
}: {
  repository: Repository | null;
  csrf: string | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(repository?.name ?? "");
  const [key, setKey] = useState(repository?.key ?? "");
  const [visibility, setVisibility] = useState<Repository["visibility"]>(
    repository?.visibility ?? "private",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api(
        repository
          ? `/api/manage/repositories/${repository.id}`
          : "/api/manage/repositories",
        {
          method: repository ? "PATCH" : "POST",
          body: JSON.stringify({ name, key, visibility }),
        },
        csrf,
      );
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={repository ? "编辑仓库" : "新增仓库"} onClose={onClose}>
      <label className="field">
        <span>显示名称</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span>URL key</span>
        <input
          value={key}
          onChange={(event) =>
            setKey(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
          }
        />
      </label>
      <label className="field">
        <span>可见性</span>
        <select
          value={visibility}
          onChange={(event) =>
            setVisibility(event.target.value as Repository["visibility"])
          }
        >
          <option value="public">公开 · 可发现</option>
          <option value="unlisted">不列出 · 持链接可访问</option>
          <option value="private">私密 · 仅作者</option>
        </select>
      </label>
      {repository && key !== repository.key && (
        <p className="muted-note">
          保存后，旧仓库路径和既有文章地址会永久重定向到新 URL。
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button
          className="primary-button"
          disabled={busy || !name || !key}
          onClick={() => void submit()}
        >
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Dialog>
  );
}

function RepositoryDeleteDialog({
  repository,
  repositories,
  csrf,
  onClose,
  onDeleted,
}: {
  repository: Repository;
  repositories: Repository[];
  csrf: string | null;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const targets = repositories.filter((item) => item.id !== repository.id);
  const [action, setAction] = useState<"move" | "delete">(
    targets.length ? "move" : "delete",
  );
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/auth/reauth",
        { method: "POST", body: JSON.stringify({ password }) },
        csrf,
      );
      await api(
        `/api/manage/repositories/${repository.id}`,
        {
          method: "DELETE",
          body: JSON.stringify(
            action === "move"
              ? { action, targetRepositoryId: target }
              : { action },
          ),
        },
        csrf,
      );
      await onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };
  const ready =
    password &&
    ((action === "move" && target) ||
      (action === "delete" && typed === repository.name));
  return (
    <Dialog title={`删除仓库 · ${repository.name}`} onClose={onClose}>
      <p>这是高风险操作。请选择仓库内文章的处理方式，并再次输入站内密码。</p>
      {targets.length > 0 && (
        <label className="choice-row">
          <input
            type="radio"
            checked={action === "move"}
            onChange={() => setAction("move")}
          />
          <span>
            <strong>迁移文章</strong>
            <small>文章移动到目标仓库根目录；旧公开 URL 自动重定向。</small>
          </span>
        </label>
      )}{" "}
      {action === "move" && (
        <label className="field">
          <span>目标仓库</span>
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {targets.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="choice-row">
        <input
          type="radio"
          checked={action === "delete"}
          onChange={() => setAction("delete")}
        />
        <span>
          <strong>连同内容永久删除</strong>
          <small>文章、公开快照和历史归档都会删除；已公开地址返回 410。</small>
        </span>
      </label>
      {action === "delete" && (
        <label className="field">
          <span>输入仓库名“{repository.name}”确认</span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>站内密码</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button
          className="danger-button"
          disabled={busy || !ready}
          onClick={() => void submit()}
        >
          {busy ? "处理中…" : "确认删除仓库"}
        </button>
      </div>
    </Dialog>
  );
}

function PostDangerDialog({
  action,
  post,
  onClose,
  onConfirm,
}: {
  action: "withdraw" | "delete";
  post: PostDetail;
  onClose: () => void;
  onConfirm: (action: "withdraw" | "delete", password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm(action, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const deleting = action === "delete";
  return (
    <Dialog
      title={deleting ? "永久删除文章" : "撤回公开文章"}
      onClose={onClose}
    >
      <p>
        {deleting
          ? "工作稿、历史版本、公开快照和旧 URL 都会被处理；所有已公开地址随后返回 410 Gone。"
          : "公开访问、公共搜索、RSS 与 sitemap 会立即停止提供这篇文章；工作稿和历史仍保留。已被阅读器下载的副本无法远程收回。"}
      </p>
      {deleting && (
        <label className="field">
          <span>输入文章标题“{post.title}”确认</span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>再次输入站内密码</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button
          className="danger-button"
          disabled={busy || !password || (deleting && typed !== post.title)}
          onClick={() => void submit()}
        >
          {busy ? "处理中…" : deleting ? "永久删除" : "确认撤回"}
        </button>
      </div>
    </Dialog>
  );
}

function CategoryDialog({
  workspace,
  csrf,
  onClose,
  onChanged,
}: {
  workspace: RepositoryWorkspace;
  csrf: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [categories, setCategories] = useState(workspace.categories);
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const openEditor = (value: Category | "new") => {
    setEditing(value);
    setName(value === "new" ? "" : value.name);
    setParentId(value === "new" ? null : value.parentId);
    setError("");
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (editing === "new") {
        const data = await api<{ category: Category }>(
          "/api/manage/categories",
          {
            method: "POST",
            body: JSON.stringify({
              repositoryId: workspace.repository.id,
              parentId,
              name,
            }),
          },
          csrf,
        );
        setCategories((current) => [...current, data.category]);
      } else if (editing) {
        const data = await api<{ category: Category }>(
          `/api/manage/categories/${editing.id}`,
          { method: "PATCH", body: JSON.stringify({ name, parentId }) },
          csrf,
        );
        setCategories((current) =>
          current.map((item) =>
            item.id === data.category.id ? data.category : item,
          ),
        );
      }
      setEditing(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/manage/categories/${deleting.id}`,
        { method: "DELETE" },
        csrf,
      );
      setCategories((current) =>
        current.filter((item) => item.id !== deleting.id),
      );
      setDeleting(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`分类 · ${workspace.repository.name}`}
      className="category-dialog"
      onClose={onClose}
    >
      <div className="category-toolbar">
        <p>分类可以递归嵌套；未分类文章保留在仓库根目录。</p>
        <button className="primary-button" onClick={() => openEditor("new")}>
          新增分类
        </button>
      </div>
      <div className="category-list">
        {categoryOptions(categories).map(({ category, depth }) => {
          const postCount = workspace.posts.filter(
            (post) => post.categoryId === category.id,
          ).length;
          const childCount = categories.filter(
            (item) => item.parentId === category.id,
          ).length;
          return (
            <article key={category.id} style={{ paddingLeft: depth * 18 }}>
              <Icon name="folder" />
              <span>
                <strong>{category.name}</strong>
                <small>
                  {postCount} 篇文章 · {childCount} 个子分类
                </small>
              </span>
              <button
                className="text-button"
                onClick={() => openEditor(category)}
              >
                编辑
              </button>
              <button
                className="text-button danger-text"
                onClick={() => {
                  setDeleting(category);
                  setError("");
                }}
              >
                删除
              </button>
            </article>
          );
        })}
        {!categories.length && <p className="muted-note">还没有分类。</p>}
      </div>
      {editing && (
        <section className="inline-editor">
          <h3>{editing === "new" ? "新增分类" : "编辑分类"}</h3>
          <label className="field">
            <span>名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>上级分类</span>
            <select
              value={parentId ?? ""}
              onChange={(event) => setParentId(event.target.value || null)}
            >
              <option value="">仓库根目录</option>
              {categoryOptions(categories)
                .filter(
                  ({ category }) =>
                    editing === "new" || category.id !== editing.id,
                )
                .map(({ category, depth }) => (
                  <option key={category.id} value={category.id}>
                    {"— ".repeat(depth)}
                    {category.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
            <button
              className="primary-button"
              disabled={busy || !name.trim()}
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
        </section>
      )}
      {deleting && (
        <section className="inline-danger">
          <p>删除“{deleting.name}”？只有不含文章和子分类的空分类可以删除。</p>
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void remove()}
            >
              确认删除
            </button>
          </div>
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onClose}>
          完成
        </button>
      </div>
    </Dialog>
  );
}

function mediaType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        avif: "image/avif",
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
        ogg: "audio/ogg",
        wav: "audio/wav",
        webm: "video/webm",
        mp4: "video/mp4",
        mov: "video/quicktime",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}

function extractZip(file: File): Promise<{
  documents: Array<{ path: string; content: string }>;
  attachments: Array<{ path: string; buffer: ArrayBuffer }>;
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./importZip.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (
      event: MessageEvent<{
        documents?: Array<{ path: string; content: string }>;
        attachments?: Array<{ path: string; buffer: ArrayBuffer }>;
        error?: string;
      }>,
    ) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else
        resolve({
          documents: event.data.documents ?? [],
          attachments: event.data.attachments ?? [],
        });
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("ZIP 解压 Worker 失败"));
    };
    void file.arrayBuffer().then((buffer) =>
      worker.postMessage({ buffer }, [buffer]),
    );
  });
}

function ImportDialog({
  repositoryId,
  categoryId,
  csrf,
  onUpload,
  onClose,
  onCommitted,
}: {
  repositoryId: string;
  categoryId: string | null;
  csrf: string | null;
  onUpload: (file: File, importBatchId: string) => Promise<MediaUpload>;
  onClose: () => void;
  onCommitted: (posts: PostDetail[]) => void | Promise<void>;
}) {
  const folderRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>(
    [],
  );
  const [attachments, setAttachments] = useState<Map<string, File>>(new Map());
  const [items, setItems] = useState<ImportItem[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [unreferenced, setUnreferenced] = useState<string[]>([]);
  const [attachmentConflicts, setAttachmentConflicts] = useState<
    ImportPreview["attachmentConflicts"]
  >([]);
  const [batchId, setBatchId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);
  const preview = async (
    documentFiles: Array<{ path: string; content: string }>,
    assetFiles: Map<string, File>,
    assetIds: Map<string, string> = new Map(),
  ) => {
    const data = await api<ImportPreview>(
      "/api/manage/import/preview",
      {
        method: "POST",
        body: JSON.stringify({
          repositoryId,
          categoryId,
          files: documentFiles,
          attachments: [...assetFiles.keys()].map((path) => ({
            path,
            assetId: assetIds.get(path),
          })),
        }),
      },
      csrf,
    );
    return data;
  };
  const scan = async (selected: FileList | null) => {
    if (!selected?.length) return;
    setBusy(true);
    setError("");
    try {
      const documents: Array<{ path: string; content: string }> = [];
      const media = new Map<string, File>();
      for (const file of [...selected]) {
        const path = (file.webkitRelativePath || file.name).replaceAll(
          "\\",
          "/",
        );
        if (/\.zip$/i.test(path)) {
          const extracted = await extractZip(file);
          documents.push(...extracted.documents);
          for (const attachment of extracted.attachments) {
            media.set(
              attachment.path,
              new File(
                [attachment.buffer],
                attachment.path.split("/").at(-1) ?? "media",
                { type: mediaType(attachment.path) },
              ),
            );
          }
        } else if (path.split("/").includes(".obsidian")) continue;
        else if (/\.md$/i.test(path))
          documents.push({ path, content: await file.text() });
        else media.set(path, file);
      }
      if (!documents.length) throw new Error("没有找到 Markdown 文件");
      if (documents.length > 100)
        throw new Error("标准导入一次最多 100 篇文章");
      const data = await preview(documents, media);
      setFiles(documents);
      setAttachments(media);
      setIgnored(data.ignored);
      setUnreferenced(data.unreferencedAttachments);
      setAttachmentConflicts(data.attachmentConflicts);
      setBatchId(crypto.randomUUID());
      setItems(
        data.items.map((item) => {
          const identical = item.duplicateCandidates.find(
            (candidate) => candidate.reason === "内容完全相同",
          );
          const verified = item.exportedPostIdVerified
            ? item.duplicateCandidates.find(
                (candidate) => candidate.reason === "本站导出签名已验证",
              )
            : undefined;
          return {
            ...item,
            action: verified ? "update" : identical ? "skip" : "new",
            targetPostId: verified?.postId,
            preserveFirstPublishedAt: null,
          };
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "扫描失败");
    } finally {
      setBusy(false);
    }
  };
  const update = (key: string, patch: Partial<ImportItem>) =>
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  const commit = async () => {
    setBusy(true);
    setError("");
    try {
      const active = items.filter((item) => item.action !== "skip");
      if (!active.length) throw new Error("没有选择要导入的文章");
      const needed = new Set(
        active.flatMap((item) => Object.values(item.attachmentMatches)),
      );
      const assetIds = new Map<string, string>();
      for (const path of needed) {
        const file = attachments.get(path);
        if (!file) throw new Error(`找不到待上传附件：${path}`);
        const uploaded = await onUpload(file, batchId);
        assetIds.set(path, uploaded.asset.id);
      }
      const resolvedPreview = await preview(files, attachments, assetIds);
      const finalItems: ImportItem[] = resolvedPreview.items.map((fresh) => {
        const chosen = items.find((item) => item.path === fresh.path);
        return {
          ...fresh,
          action: chosen?.action ?? "new",
          targetPostId: chosen?.targetPostId,
          preserveFirstPublishedAt: chosen?.preserveFirstPublishedAt ?? null,
          title: chosen?.title ?? fresh.title,
          slug: chosen?.slug ?? fresh.slug,
        };
      });
      const data = await api<{ posts: PostDetail[] }>(
        "/api/manage/import/commit",
        {
          method: "POST",
          body: JSON.stringify({
            batchId,
            repositoryId,
            categoryId,
            items: finalItems,
          }),
        },
        csrf,
      );
      await onCommitted(data.posts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="导入 Markdown" className="import-dialog" onClose={onClose}>
      {!items.length ? (
        <>
          <p>
            可以导入单个或多个 `.md`、整个文件夹，或
            `.zip`。初次扫描只做预检，不会写入文章或上传附件。
          </p>
          <div className="import-pickers">
            <label className="primary-button">
              <Icon name="upload" />
              选择文件
              <input
                hidden
                type="file"
                multiple
                accept=".md,.zip,image/*,audio/*,video/*"
                onChange={(event) => {
                  void scan(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            <label className="secondary-button">
              <Icon name="folder" />
              选择文件夹
              <input
                ref={folderRef}
                hidden
                type="file"
                multiple
                onChange={(event) => {
                  void scan(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        </>
      ) : (
        <>
          <p>
            {items.length}{" "}
            篇文章待确认。目录会递归映射为分类；同名和相似内容不会自动覆盖。
          </p>
          <div className="import-items">
            {items.map((item) => (
              <article key={item.key} className="import-item">
                <div className="import-item-head">
                  <strong>{item.path}</strong>
                  <select
                    value={item.action}
                    onChange={(event) =>
                      update(item.key, {
                        action: event.target.value as ImportItem["action"],
                        targetPostId:
                          event.target.value === "update"
                            ? (item.targetPostId ??
                              item.duplicateCandidates[0]?.postId)
                            : undefined,
                      })
                    }
                  >
                    <option value="new">作为新文章</option>
                    {item.duplicateCandidates.length > 0 && (
                      <option value="update">更新既有工作稿</option>
                    )}
                    <option value="skip">跳过</option>
                  </select>
                </div>
                {item.exportedPostIdVerified && (
                  <p className="muted-note">
                    本站导出签名已验证，已准确关联原文章；仍可改为新建或跳过。
                  </p>
                )}
                {item.action !== "skip" && (
                  <div className="import-fields">
                    <label className="field">
                      <span>标题</span>
                      <input
                        value={item.title}
                        onChange={(event) =>
                          update(item.key, { title: event.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>
                        slug {item.slugConflict && <em>存在冲突，请修改</em>}
                      </span>
                      <input
                        value={item.slug}
                        onChange={(event) =>
                          update(item.key, {
                            slug: event.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9-]/g, "-"),
                            slugConflict: false,
                          })
                        }
                      />
                    </label>
                    {item.action === "update" && (
                      <label className="field">
                        <span>目标文章</span>
                        <select
                          value={item.targetPostId ?? ""}
                          onChange={(event) =>
                            update(item.key, {
                              targetPostId: event.target.value,
                            })
                          }
                        >
                          {item.duplicateCandidates.map((candidate) => (
                            <option
                              value={candidate.postId}
                              key={candidate.postId}
                            >
                              {candidate.title} · {candidate.reason}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {item.publishedTimeCandidate?.parsedAt ? (
                      <label className="import-time-confirm">
                        <input
                          type="checkbox"
                          checked={Boolean(item.preserveFirstPublishedAt)}
                          onChange={(event) =>
                            update(item.key, {
                              preserveFirstPublishedAt: event.target.checked
                                ? item.publishedTimeCandidate?.parsedAt
                                : null,
                            })
                          }
                        />
                        <span>
                          保留为首次发布时间：
                          <strong>
                            {new Intl.DateTimeFormat("zh-CN", {
                              dateStyle: "long",
                              timeStyle: "medium",
                              timeZone: "UTC",
                            }).format(
                              new Date(item.publishedTimeCandidate.parsedAt),
                            )}
                          </strong>
                          （源值 {item.publishedTimeCandidate.raw} ·
                          {item.publishedTimeCandidate.timezone}，入库统一为 UTC）
                        </span>
                      </label>
                    ) : item.publishedTimeCandidate ? (
                      <label className="field">
                        <span>
                          原发布时间需要补充确认：
                          {item.publishedTimeCandidate.issue}
                        </span>
                        <input
                          placeholder="2024-01-01T10:00:00+13:00"
                          value={item.preserveFirstPublishedAt ?? ""}
                          onChange={(event) =>
                            update(item.key, {
                              preserveFirstPublishedAt:
                                event.target.value || null,
                            })
                          }
                        />
                      </label>
                    ) : null}
                  </div>
                )}
                {item.missingAttachments.length > 0 && (
                  <p className="form-error">
                    缺失或歧义附件：{item.missingAttachments.join("、")}
                  </p>
                )}{" "}
                {Object.keys(item.attachmentMatches).length > 0 && (
                  <p className="muted-note">
                    确认后上传 {Object.keys(item.attachmentMatches).length}{" "}
                    个已匹配附件。
                  </p>
                )}
              </article>
            ))}
          </div>
          {ignored.length > 0 && (
            <p className="muted-note">已忽略：{ignored.join("、")}</p>
          )}
          {unreferenced.length > 0 && (
            <p className="muted-note">
              未被引用，默认不上传：{unreferenced.join("、")}
            </p>
          )}
          {attachmentConflicts.length > 0 && (
            <div className="form-error" role="alert">
              <strong>附件路径存在大小写或重复冲突，未自动猜测：</strong>
              <ul>
                {attachmentConflicts.map((conflict) => (
                  <li key={`${conflict.normalizedPath}:${conflict.paths.join()}`}>
                    {conflict.paths.join(" ↔ ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
        {items.length > 0 && (
          <button
            className="primary-button"
            disabled={busy || items.every((item) => item.action === "skip")}
            onClick={() => void commit()}
          >
            {busy ? "正在导入…" : "确认并导入"}
          </button>
        )}
      </div>
      {busy && <p className="muted-note">正在处理，请不要关闭窗口。</p>}
    </Dialog>
  );
}

function ScheduleDialog({
  timezone,
  onClose,
  onSubmit,
}: {
  timezone: string;
  onClose: () => void;
  onSubmit: (local: string, timezone: string, utc: string) => Promise<void>;
}) {
  const [local, setLocal] = useState("");
  const [zone, setZone] = useState(timezone);
  const [error, setError] = useState("");
  const submit = async () => {
    try {
      const utc = zonedLocalToUtc(local, zone);
      await onSubmit(local, zone, utc);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "时间无效");
    }
  };
  return (
    <Dialog title="定时发布" onClose={onClose}>
      <label className="field">
        <span>当地日期与时间</span>
        <input
          type="datetime-local"
          step="1"
          value={local}
          onChange={(event) => setLocal(event.target.value)}
        />
      </label>
      <label className="field">
        <span>IANA 时区</span>
        <input value={zone} onChange={(event) => setZone(event.target.value)} />
      </label>
      <p>
        系统会同时保存当地时间语义、IANA 时区和换算后的 UTC
        时刻，夏令时变化不会改写已确认的执行时刻。
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button
          className="primary-button"
          disabled={!local || !zone}
          onClick={() => void submit()}
        >
          确认计划
        </button>
      </div>
    </Dialog>
  );
}
function zonedLocalToUtc(local: string, timeZone: string): string {
  if (!local) throw new Error("请选择时间");
  const desired = new Date(`${local}Z`);
  if (Number.isNaN(desired.getTime())) throw new Error("时间无效");
  let guess = desired.getTime();
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (let i = 0; i < 4; i++) {
    const shown = new Date(
      `${formatter.format(new Date(guess)).replace(" ", "T")}Z`,
    ).getTime();
    guess += desired.getTime() - shown;
  }
  const final = formatter.format(new Date(guess)).replace(" ", "T");
  if (final !== local.padEnd(19, ":00").slice(0, 19))
    throw new Error("这个当地时间可能处于夏令时跳转的不存在区间");
  return new Date(guess).toISOString();
}
