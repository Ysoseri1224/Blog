# Blog 内容库正式恢复手册

本流程只恢复 `blog-content`。`blog-search` 是可重建索引，不从 SQL 备份覆盖恢复。任何正式恢复都先导入新 D1，完成校验后再切换 Worker binding；禁止直接覆盖当前生产库。

## 1. 选择并冻结恢复点

1. 在私有 `blog-backups` R2 中选择一个 `daily/<date>/<timestamp>-attempt-<n>/manifest.json`。
2. 记录当前生产 Worker 版本、`blog-content` database ID、`blog-search` database ID 和恢复操作者。
3. 恢复期间暂停写作与发布入口；公开阅读可继续使用旧库。
4. 若是近期误操作，先评估 D1 Time Travel。即使使用 Time Travel，也要记录恢复前后校验结果。

## 2. 下载并验证备份

下载 manifest 所列全部 part，严格保持 manifest 中的顺序。对每个文件计算 SHA-256，并与 `parts[].checksum` 比对；再对按顺序排列的 checksum JSON 数组计算 SHA-256，与 `partsChecksum` 比对。任何对象缺失、字节数不符或 checksum 不符都立即终止。

同时检查：

- `format` 必须为 `ysoseri-blog-sql-parts-v1`。
- `schemaVersion` 必须是当前代码支持的迁移版本。
- `excludedTransientTables` 只能包含可安全重建的会话、outbox、删除任务与操作守卫表。
- `object-references.json` 必须存在并通过 checksum 校验。

## 3. 拼接 SQL 并导入新 D1

按 manifest 顺序拼接所有 `.sql` part，不能按文件名自行猜测顺序。拼接结果应从 `BEGIN TRANSACTION` 开始，以 `COMMIT` 和恢复外键设置结束。

创建全新的恢复库，不复用生产 database ID：

```powershell
npx wrangler d1 create blog-content-restore-YYYYMMDD-HHMM
npx wrangler d1 execute blog-content-restore-YYYYMMDD-HHMM --remote --file .\restore\combined.sql
```

保留 Wrangler 返回的新 database ID，暂不改 `wrangler.jsonc`。

## 4. 内容与对象引用校验

对新库执行以下只读校验，并与 manifest 的 `tables[].count` 逐表比对：

```sql
PRAGMA foreign_key_check;
SELECT count(*) FROM repositories;
SELECT count(*) FROM categories;
SELECT count(*) FROM posts;
SELECT count(*) FROM post_versions;
SELECT count(*) FROM public_snapshots;
SELECT count(*) FROM media_assets;
SELECT count(*) FROM posts WHERE public_visible=1 AND public_snapshot_id IS NULL;
SELECT count(*) FROM posts p LEFT JOIN repositories r ON r.id=p.repository_id WHERE r.id IS NULL;
SELECT count(*) FROM posts p LEFT JOIN public_snapshots s ON s.id=p.public_snapshot_id
 WHERE p.public_snapshot_id IS NOT NULL AND s.id IS NULL;
```

验收条件：`PRAGMA foreign_key_check` 无结果，两个公开指针/仓库孤儿查询均为 `0`。

逐项 HEAD 检查 `object-references.json`：

- `blogArchive` 中每个 key 必须存在于 `blog-archive`。
- `siteMedia` 中每个 key 必须存在于 `ysoseri-media`。
- 记录对象总数、缺失 key 和抽样对象的 custom metadata；只要有缺失对象就不能切换。

## 5. 预览环境与 binding 切换

1. 用新 D1 database ID 创建临时 Wrangler 配置或预览 Worker。
2. 运行管理登录、仓库权限、草稿读取、公开文章、媒体权限、RSS、sitemap 和旧地址重定向冒烟测试。
3. 将生产 `CONTENT_DB` binding 切换到新 database ID；保留旧库，不删除。
4. 部署后立即重复公开与管理端冒烟测试，并记录 Worker deployment ID。

若校验失败，立即把 binding 切回旧 database ID。不要在故障现场修改新旧库内容来“凑齐”校验。

## 6. 重建搜索库

创建新的空 `blog-search` D1，应用 `migrations/search`，将 `SEARCH_DB` 临时绑定到新库，然后执行一次 `reconcileSearchIndexes()`。确认：

- 作者索引包含全部未删除文章。
- 公共索引仅包含 `public_visible=1` 且仓库非 `private` 的当前公开快照。
- 私密、已撤回和已删除内容无法从公共搜索命中。
- 中英文、标签、路径和属性搜索抽样结果正确。

搜索验收后再完成最终 binding 切换。

## 7. 收尾记录

记录所用 manifest key、manifest checksum、新旧 D1 ID、各表计数、R2 引用校验结果、搜索重建结果、部署 ID、开始/完成时间和操作者。旧库至少保留到人工确认窗口结束；删除旧库和设置备份 Lifecycle 都是独立高风险操作。

`BACKUP_RETENTION_DAYS=UNCONFIRMED` 时不得创建自动删除 Lifecycle，也不得把占位值解释为 30 天。保留周期必须由用户最后单独确认。
