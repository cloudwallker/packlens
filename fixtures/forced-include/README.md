# forced-include

Self-written synthetic example for npm-single-package-v1. Controls and expected sets live outside the package directory. Lifecycle scripts are sentinels and must never run.

```sh
node dist/cli.js analyze fixtures/forced-include/package --intent fixtures/forced-include/intent.json
node dist/cli.js simulate fixtures/forced-include/package --intent fixtures/forced-include/intent.json --patch fixtures/forced-include/patch.json
node dist/cli.js demo forced-include --html ../forced-include.html
```

expected.json records fixed-profile baseline and patch file sets and ordered assertion outcomes. All scenes are calculated using the same engine.
