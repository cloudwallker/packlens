# template-missing

Self-written synthetic example for npm-single-package-v1. Controls and expected sets live outside the package directory. Lifecycle scripts are sentinels and must never run.

```sh
node dist/cli.js analyze fixtures/template-missing/package --intent fixtures/template-missing/intent.json
node dist/cli.js simulate fixtures/template-missing/package --intent fixtures/template-missing/intent.json --patch fixtures/template-missing/patch.json
node dist/cli.js demo template-missing --html ../template-missing.html
```

expected.json records fixed-profile baseline and patch file sets and ordered assertion outcomes. All scenes are calculated using the same engine.
