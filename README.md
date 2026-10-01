# CCF Online

会议截稿、CCF 推荐目录与期刊分区的一站式查询页面。

在线地址：<https://www.weili.space/ccf/>

## 功能

- **会议截稿**：数据来自 [ccfddl](https://ccfddl.com/)。截稿时间按会议原时区（AoE、UTC±N、PT 等）换算，可切换为北京时间、本机时区或原时区显示，带倒计时；多轮截稿自动取下一轮，同时显示摘要截止时间和录用率。
- **CCF 推荐目录（2026 版）**：按领域、类型、级别、出版社筛选。期刊附带 JCR 影响因子和中科院分区，会议附带下一个截稿时间。
- **期刊分区**：JCR 影响因子 / 分区与中科院分区合并查询，可筛出 CCF 收录的期刊及其等级。
- **时区换算**：基于 IANA 时区数据库，自动处理夏令时。
- 筛选条件写在 URL 里，复制链接即可分享当前视图；深色模式跟随系统，并与 [主页](https://www.weili.space/) 共用设置。

## 数据与更新

```
data-src/            原始数据（手工维护）
  ccf-2026.md        CCF 推荐目录
  jcr.xlsx           第 1 个工作表为 JCR，第 2 个为中科院分区
data/                构建产物，页面只读这里（同源加载，国内访问更快）
scripts/build-data.mjs
```

```bash
npm install
npm run build      # 拉取 ccfddl 最新数据并重新生成 data/
npm test
npm run serve      # 本地预览 http://127.0.0.1:8080/
```

- 会议数据：`npm run build` 会生成快照；页面打开时若快照超过 1 天，会在浏览器里自动从 ccfddl 刷新，失败则继续用快照。
- JCR / 中科院分区：替换 `data-src/jcr.xlsx` 后，修改 `scripts/build-data.mjs` 顶部 `SOURCES` 里的版本号（列名按 `<年份>JIF`、`<年份>分区` 读取），再运行 `npm run build`。
- 新版 CCF 目录：放入 `data-src/` 并更新 `SOURCES.ccfList`。
- 期刊名在 JCR 中写法不同导致匹配不上时，可在 `ISSN_OVERRIDES` 中按 ISSN 指定。

数据仅供参考，请以各官方发布为准。

## 维护者

[Wei Li (William)](https://www.weili.space/)，liwei008009@163.com

## License

Apache-2.0。`assets/vendor/js-yaml.js` 为 [js-yaml](https://github.com/nodeca/js-yaml)（MIT）。
