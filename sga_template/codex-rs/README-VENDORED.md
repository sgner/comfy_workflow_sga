# Vendored Code Notice

本目录包含从上游项目 vendor 来的源码, 仅作为本项目的一部分进行分发和修改。

## 来源

- **上游项目**: [openai/codex](https://github.com/openai/codex)
- **上游分支**: `main`
- **Vendor 时间**: 2026-06-22
- **上游 Tag**: rust-vv0.99.0-alpha.8 (vendor 时最新)
- **License**: Apache License 2.0 ([LICENSE](./LICENSE))

## 目录说明

| 路径 | 说明 |
|------|------|
| `sga_template/codex-rs/` | 仅 vendor Rust 工作区, 不含 `codex-cli`/Python 等其他子项目 |
| `sga_template/codex-rs/LICENSE` | Apache-2.0 许可证全文 |
| `sga_template/codex-rs/NOTICE` | 上游版权声明 (如有) |

## 修改记录

本项目可能对 vendor 代码进行本地修改, 详见 `git log sga_template/codex-rs/`。

**重要**: 本目录的代码与上游 openai/codex 同步是**手动的**。如需拉取上游新版本:

```bash
# 1. 备份当前 vendor 代码
cp -r sga_template/codex-rs /tmp/codex-rs-backup

# 2. 重新下载上游 main 分支
curl -L https://codeload.github.com/openai/codex/tar.gz/refs/heads/main -o /tmp/codex.tar.gz
tar -xzf /tmp/codex.tar.gz -C /tmp/

# 3. 替换本地 vendor 目录
rm -rf sga_template/codex-rs
mv /tmp/codex-main/codex-rs sga_template/codex-rs
cp /tmp/codex-main/LICENSE sga_template/codex-rs/LICENSE
[ -f /tmp/codex-main/NOTICE ] && cp /tmp/codex-main/NOTICE sga_template/codex-rs/NOTICE

# 4. 重新应用本地修改
#    使用 git log 对比 /tmp/codex-rs-backup 找回改动
```

## 重新同步上游 (使用 git subtree)

如未来希望以 subtree 方式管理与上游的同步:

```bash
# 一次性将 sga_template/codex-rs/ 转为 subtree 远程
git remote add codex-upstream https://github.com/openai/codex.git
git subtree add --prefix=sga_template/codex-rs codex-upstream main

# 后续拉取上游更新
git subtree pull --prefix=sga_template/codex-rs codex-upstream main

# 提交本地修改回上游 (如需)
git subtree push --prefix=sga_template/codex-rs codex-upstream my-branch
```

## License 合规

依据 Apache-2.0 许可证要求:

1. ✅ 保留上游 LICENSE 文件
2. ✅ 保留上游版权声明 (NOTICE)
3. ✅ 修改的部分需明确标注 (见本文件)
4. ⚠️ 修改后的代码沿用 Apache-2.0 许可证 (与本项目 MIT 许可证通过 dual-licensing 兼容)

### License 兼容性说明

- 本项目: MIT
- vendor 的 codex-rs: Apache-2.0
- 兼容性: ✅ MIT 与 Apache-2.0 兼容, 可在同一仓库中混合使用
- 建议对外分发时附上 `THIRD_PARTY_LICENSES.md` 文件
