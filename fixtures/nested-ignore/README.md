# nested-ignore

Self-written synthetic example for npm-single-package-v1. Controls and expected sets live outside the package directory. Lifecycle scripts are sentinels and must never run.

```sh
node dist/cli.js analyze fixtures/nested-ignore/package --intent fixtures/nested-ignore/intent.json
node dist/cli.js simulate fixtures/nested-ignore/package --intent fixtures/nested-ignore/intent.json --patch fixtures/nested-ignore/patch.json
node dist/cli.js demo nested-ignore --html ../nested-ignore.html
```

expected.json records fixed-profile baseline and patch file sets and ordered assertion outcomes. All scenes are calculated using the same engine.
