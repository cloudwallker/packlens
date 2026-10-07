# Contributing

Use Node 24.15.0 and the committed lock. Install without lifecycle scripts, then build and install the declared browser:

```sh
npm ci --ignore-scripts
npm run build
npx --no-install playwright install chromium
npm test
```

Linux browser setup may require `npx --no-install playwright install --with-deps chromium`. `PLAYWRIGHT_BROWSERS_PATH` can locate a project-specific cache. It belongs in your shell environment, not a committed machine-specific path.

Write a failing behavior test before an implementation change. Rule changes need real four-way differential tests and source-location assertions. Compare physically patched fixtures, preserve unknown states, and check source hashes and lifecycle sentinels. UI changes need actual browser interaction at 1440 and 390 CSS pixels and hostile text coverage. Set `PACKLENS_CAPTURE_SCREENSHOTS=1` when intentionally updating synthetic screenshots.

`scripts/create-fixtures.mjs` deterministically creates the six self-written examples. `npm run build` bundles only their controlled assets into JSON. `npm run licenses` regenerates full notices from the locked install. After dependency updates verify profile hashes/semantics, and inspect the packed file list and an isolated `--omit=dev` install.

Keep private reports, credentials, environment configuration and local process material out of commits. Maintain both READMEs when user-facing behavior changes. A configured CI job is reported as configured until a real run succeeds.

中文：使用固定 Node 与锁定依赖，先写行为失败测试，再实现与核验。规则改动须做四方差分与真实来源定位；界面改动须跑浏览器与窄屏验收。同步中英文文档，公开材料使用合成数据。
