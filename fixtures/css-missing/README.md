# css-missing

Self-written synthetic example for npm-single-package-v1. Controls and expected sets live outside the package directory. Lifecycle scripts are sentinels and must never run.

```sh
node dist/cli.js analyze fixtures/css-missing/package --intent fixtures/css-missing/intent.json
node dist/cli.js simulate fixtures/css-missing/package --intent fixtures/css-missing/intent.json --patch fixtures/css-missing/patch.json
node dist/cli.js demo css-missing --html ../css-missing.html
```

expected.json records fixed-profile baseline and patch file sets and ordered assertion outcomes. All scenes are calculated using the same engine.
