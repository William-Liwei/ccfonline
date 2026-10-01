# CCF Online

会议截稿、CCF 推荐目录与期刊分区的一站式查询页面。

在线地址：<https://www.weili.space/ccf/>

## 功能

- **会议截稿**：数据来自 [ccfddl](https://ccfddl.com/)。截稿时间按会议原时区（AoE、UTC±N、PT 等）换算，可切换为北京时间、本机时区或原时区显示，带倒计时；多轮截稿自动取下一轮，同时显示摘要截止时间和录用率。
- **CCF 推荐目录（2026 版）**：按领域、类型、级别、出版社筛选。期刊附带 JCR 影响因子和中科院分区，会议附带下一个截稿时间。
- **期刊分区**：JCR 2025 影响因子（2026 年 6 月发布）、中科院分区 2025、新锐分区 2026 合并查询（按 ISSN 关联），可筛出 CCF 收录的期刊及其等级，标注新锐预警期刊。
- **时区换算**：基于 IANA 时区数据库，自动处理夏令时。
- 筛选条件写在 URL 里，复制链接即可分享当前视图；深色模式跟随系统，并与 [主页](https://www.weili.space/) 共用设置。

## 数据与更新

```
data-src/            原始数据
  ccf-2026.md        CCF 推荐目录
  jcr-2025.csv       JCR 影响因子与分区
  cas-2025.csv       中科院分区表升级版
  xr-2026.csv        新锐期刊分区表
data/                构建产物，页面只读这里（同源加载，国内访问更快）
scripts/build-data.mjs
```

三个期刊 CSV 取自 [hitfyd/ShowJCR](https://github.com/hitfyd/ShowJCR)（GPL-3.0）的 `中科院分区表及JCR原始数据文件/` 目录（对应 `JCR2025-UTF8.csv`、`FQBJCR2025-UTF8.csv`、`XR2026-UTF8.csv`），未做修改。会议数据由 ccfddl 在 GitHub 维护（[ccfddl/ccf-deadlines](https://github.com/ccfddl/ccf-deadlines)，合并后的 YAML 在 `ccfddl.github.io` 仓库的 `page` 分支）。

```bash
npm install
npm run build      # 拉取 ccfddl 最新数据并重新生成 data/
npm test
npm run serve      # 本地预览 http://127.0.0.1:8080/
```

- 会议数据：`npm run build` 会生成快照；页面打开时若快照超过 1 天，会在浏览器里自动从 ccfddl 刷新，失败则继续用快照。
- 期刊分区：ShowJCR 发布新版 CSV 后放入 `data-src/`，修改 `scripts/build-data.mjs` 顶部 `SOURCES` 里的文件名和版本号，再运行 `npm run build`。JCR 每年 6 月更新，中科院分区一般 3 月，新锐分区 3 月。
- 新版 CCF 目录：放入 `data-src/` 并更新 `SOURCES.ccfList`。
- 期刊名在 JCR 中写法不同导致匹配不上时，可在 `ISSN_OVERRIDES` 中按 ISSN 指定。

数据仅供参考，请以各官方发布为准。

## 维护者

[Wei Li (William)](https://www.weili.space/)，liwei008009@163.com

## License

Apache-2.0。`assets/vendor/js-yaml.js` 为 [js-yaml](https://github.com/nodeca/js-yaml)（MIT）。
