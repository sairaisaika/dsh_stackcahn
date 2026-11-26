# 待提交上游补丁

状态：本地修复与测试通过，**尚未创建 GitHub PR**。上游为 [howecheung/dsh-xiaozhi-bridge](https://github.com/howecheung/dsh-xiaozhi-bridge)，基准提交 `58a243831d5f8ed2fc9ce18d54150e14ebccd816`。

文件：[补丁](active-session-model.patch)、[PR 描述](PR.md)。在该基准的干净上游 clone 中运行：

```sh
git apply --check /path/to/active-session-model.patch
git apply /path/to/active-session-model.patch
node --test
```

本地先复现 1 fail / 1 pass，修复后 2 pass。CI 增加 `node --test`。这是会话状态报告修复，不代表实现了连续音频、人格绑定或共享记忆。

发布阻碍（本轮复核）：GitHub 插件已登录并能访问用户仓库，目标 fork 尚不存在；可用工具没有创建 fork 的能力。无需重新登录插件。未向上游发消息、issue 或 PR。取得可用 fork 后可用连接器创建分支与 PR；无需重做研究和补丁。
