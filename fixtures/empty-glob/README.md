# empty-glob

Self-written synthetic example for npm-single-package-v1. Controls and expected sets live outside the package directory. Lifecycle scripts are sentinels and must never run.

```sh
node dist/cli.js analyze fixtures/empty-glob/package --intent fixtures/empty-glob/intent.json
node dist/cli.js simulate fixtures/empty-glob/package --intent fixtures/empty-glob/intent.json --patch fixtures/empty-glob/patch.json
node dist/cli.js demo empty-glob --html ../empty-glob.html
```

expected.json records fixed-profile baseline and patch file sets and ordered assertion outcomes. All scenes are calculated using the same engine.
