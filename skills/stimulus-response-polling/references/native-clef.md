# Use native Cloudflare Clef for visual questions

Pin Clef explicitly when the full study must use one provider, or enable automatic provider selection when Sheg should route each reached unit to an eligible configured provider. A pixel-bound question requires the Clef capability, so automatic routing selects an enabled Clef entry for that unit and may use another provider for text-only units. Sheg calls Cloudflare directly and does not fall back to another provider after a Clef failure. See [Provider selection](provider-selection.md) for preferences, pins, and comparisons.

Connect the key through Sheg's local secure credential helper. The key is stored in Windows Credential Manager under the fixed `Sheg/Clef/Cloudflare` target. The Cloudflare account ID belongs in provider configuration, not the key field. Custom Workers AI tokens need Workers AI Read and Workers AI Edit permissions.

```powershell
node .\dist\cli.js provider-credential --route clef --operation setup
node .\dist\cli.js provider-credential --route clef --operation status
```

Use `provider_credential` through MCP for the same `status`, `setup`, and `remove` operations. Setup requires a local interactive Windows session. Sheg does not accept a secret as tool input or return it. Native model selectors are `clef` and `clef-flash`; there is no endpoint override.

Import and inspect the image before designing the request. Add a factual agent-authored `altText` and exact authored caption to image material. Choose `visual.mode: "pixels"` when the question requires pixel inspection, or `visual.mode: "described"` when the provided description is sufficient. A pixel prompt includes the image and omits alt text by default. A described question sends the supplied description as text and makes no claim of pixel inspection.

Bind only the images each question needs. A single-image binding is useful for judging one image in a defined context. An ordered group is useful when one question must consider several candidates together. A Choice question may map stable option IDs to image material with `materialOptions`; each mapped image must also be included in that question's `visual.mode: "pixels"` binding. This mapping identifies which image an option represents and does not create text `selectedMaterial` evidence for follow-on reuse. Clef accepts at most four images and 64 questions per call, with separate per-image byte, pixel, request-body, and conservative context limits. Ask the user before rewriting article or script material to make a request fit. Inspect the exact proposed request before acceptance; fit estimates are conservative and are not price quotes.

Later journey turns carry the exact supplied description, caption, typed reaction, and provider/model identity as compact history. Pixels are sent again only when a later question binds them explicitly. A follow-on may reference an image in its source context and bind it to a pixel question; image Choice options remain visual references and do not become text `selectedMaterial`. Inspect run evidence to confirm what was sent and which answer was recorded. A Clef result is model evidence, not a human cohort result or proof of visual accuracy.
