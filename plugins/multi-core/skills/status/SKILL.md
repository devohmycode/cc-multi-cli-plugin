---
name: status
description: Show enabled Multi providers and the active runtime location.
disable-model-invocation: true
allowed-tools: Bash
---

Run the installed helper below. It reports no credentials and performs no inference.

```sh
"$HOME/.local/share/multi-cli/bin/multi" status
```

If missing, direct the user to /multi-core:setup. New logins and plugin changes
apply when Claude is relaunched. Do not describe a listed provider as authenticated;
this command reports enablement, not an inference test.
