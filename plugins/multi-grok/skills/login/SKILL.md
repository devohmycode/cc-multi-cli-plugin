---
name: login
description: Sign in to Grok Build for the native harness.
disable-model-invocation: true
allowed-tools: Bash
---

Tell the user to run the official Grok Build sign-in in their own terminal:

```sh
"$HOME/.local/share/multi-cli/bin/multi" login grok
```

This hands off to `grok login`, which opens the browser flow, or
`grok login --device-auth` on a headless host. Check `/multi-usage` first: it
reports whether a renewable login is already present, in which case no sign-in is
needed. Tell the user that they must relaunch Claude afterward to load the Grok
rows. Never accept, request, read, or print credentials in chat; native
credentials remain owned by `grok`.
