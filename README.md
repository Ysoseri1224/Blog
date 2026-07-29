# Blog · ysoseri.us

`blog.ysoseri.us` 的公开阅读工作区与作者管理端。界面借用 Obsidian 的空间组织和操作习惯，视觉沿用 `ysoseri.us` 的暖色、字体与纸面质感。

## 技术结构

- Cloudflare Worker + Workers Static Assets
- React 19 + Vite 8
- `blog-content` D1：工作稿、公开指针、历史、权限和任务真相
- `blog-search` D1：可重建的作者 / 公共 FTS5 索引
- R2：媒体、不可变版本、公开快照与备份
- Cloudflare Workflow：一致性备份

## 本地验证

```powershell
npm install
npm run check
npm test
npm run build
npx wrangler types --check
```

本地运行前，复制 `.dev.vars.example` 为未跟踪的 `.dev.vars`，只填写密码摘要和导入导出签名密钥；不要写入 Cloudflare Token。

```powershell
npm run db:migrate:local
npm run dev:worker
```

## 生产配置

运行时 Secret：

- `AUTH_PASSWORD_HASH`
- `IMPORT_EXPORT_SIGNING_KEY`

部署顺序是创建 D1 / R2 资源、替换 `wrangler.jsonc` 中的 D1 ID、应用两座 D1 的迁移、写入 Secret、部署 Worker Custom Domain，最后执行线上鉴权、发布、撤回、搜索、备份与恢复演练。`BACKUP_RETENTION_DAYS` 未确认前不得创建自动删除 Lifecycle。

正式恢复步骤见 [docs/restore.md](docs/restore.md)。
