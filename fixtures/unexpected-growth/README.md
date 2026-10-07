# unexpected-growth

Self-written synthetic example for npm-single-package-v1. Controls and expected sets live outside the package directory. Lifecycle scripts are sentinels and must never run.

```sh
node dist/cli.js analyze fixtures/unexpected-growth/package --intent fixtures/unexpected-growth/intent.json
node dist/cli.js simulate fixtures/unexpected-growth/package --intent fixtures/unexpected-growth/intent.json --patch fixtures/unexpected-growth/patch.json
node dist/cli.js demo unexpected-growth --html ../unexpected-growth.html
```

expected.json records fixed-profile baseline and patch file sets and ordered assertion outcomes. All scenes are calculated using the same engine.
