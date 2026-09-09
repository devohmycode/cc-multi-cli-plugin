---
name: uninstall
description: Remove the Multi shell wrapper while preserving provider logins.
disable-model-invocation: true
allowed-tools: Bash
---

Run the installed helper:

```sh
"$HOME/.local/share/multi-cli/bin/multi" uninstall
```

It removes only Multi's marked shell block and its known wrapper files. If the
block was edited, report the conflict rather than deleting user content. Tell the
user to open a new terminal and uninstall the Multi provider/core plugins through
/plugin if they also want the packages removed. Provider credentials are retained.
Antigravity's separately installed, environment-scoped native hook is retained;
it is inert in ordinary agy runs.
