The unmodified policy and template are from OpenAI Codex revision
`ad931a45b201e3877d6ba542ba5dbbd85e7e31b4`, under Apache-2.0 (LICENSE and NOTICE here).

Source: https://github.com/openai/codex/tree/ad931a45b201e3877d6ba542ba5dbbd85e7e31b4/codex-rs/core/assets/guardian

`../approval.ts` composes these at runtime, replacing the execution
environment description with our actual read-only inspection tools and Claude
execution boundary. It uses the subscription `codex-auto-review` model discovered
in the account catalog. This does not port Codex's full harness, retained reviewer
sessions, tenant policy discovery, or Guardian V2. Tests use the same assets;
the earlier canary test alone adds its explicit test policy.
