# 回复珍藏馆

为 SillyTavern 角色回复增加收藏功能。

## 安装

在 SillyTavern 中打开：

1. `扩展程序`
2. `安装扩展`
3. 粘贴本仓库的 HTTPS Git URL
4. 安装完成后刷新页面

仓库地址发布后形如：

```text
https://github.com/<你的账号>/sillytavern-reply-favorites
```

## 使用

- 在角色回复右上角点击星星，收藏或取消收藏。
- 点击页面右下角的“珍藏馆”打开全局收藏面板。
- 支持关键词和角色筛选、标签、备注及原聊天定位。
- 未勾选条目时，导出当前筛选结果；勾选后只导出勾选条目。
- 支持 Markdown、单条 PNG 卡片和多条拼接长图；超长内容自动拆图。

收藏正文会作为快照保存在 SillyTavern 的扩展设置中，因此原消息被编辑或删除后仍可查看。

## 更新

通过 Git URL 安装后，可在 SillyTavern 的扩展管理页使用更新按钮拉取新版。

## 仓库结构

```text
.
├── manifest.json
├── index.js
├── style.css
└── README.md
```
