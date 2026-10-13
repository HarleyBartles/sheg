# Native Cloudflare Clef

Sheg's native Clef provider sends typed study questions and saved image bytes directly to Cloudflare Workers AI. Pin Clef explicitly when the whole study should use one provider, or let automatic routing select it for questions that require pixel inspection. Configure the enabled provider catalogue and study controls as described in [Provider selection](routing.md). Sheg does not route Clef calls through OpenRouter or fall back to another provider after a Clef failure.

For the installed agent workflow, see [Native Cloudflare Clef](../../skills/stimulus-response-polling/references/native-clef.md).

Clef can compare character sketches against a written character brief, judge whether an article image supports a section, or answer another bounded visual question. A successful answer is model evidence. It is not a human cohort result, proof of visual accuracy, or a prediction of real-world attention or reading behavior.

## Connect Cloudflare

Clef uses your Cloudflare account ID and a Workers AI API token. The account ID is provider configuration; the token stays in Windows Credential Manager. Create a Workers AI API token from the Cloudflare dashboard's Workers AI REST API page. Cloudflare's [REST API setup guide](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) says a custom token needs Workers AI Read and Workers AI Edit permissions. Review the permissions shown in your dashboard before saving the token.

The fixed credential target is `Sheg/Clef/Cloudflare`. Sheg's local secure helper prompts for the key and never accepts it as request data:

```powershell
node .\dist\cli.js provider-credential --route clef --operation setup
node .\dist\cli.js provider-credential --route clef --operation status
```

The CLI and MCP also support `status`, `setup`, and `remove` through the `provider-credential` command and `provider_credential` tool. Setup requires a local interactive Windows session. The key is read by Sheg's Windows helper, not by the model or MCP request. To remove the saved credential, run:

```powershell
node .\dist\cli.js provider-credential --route clef --operation remove
```

Sheg does not accept an endpoint override. It sends calls to `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/{model}` and refuses redirects. The account ID is not a secret, but avoid putting an access token in a study request, CLI JSON file, or chat.

## Select a model and author a request

Sheg supports the model selectors `clef` and `clef-flash`, corresponding to Cloudflare's `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`. Choose one in the request and keep it fixed for a run:

```json
{
  "provider": {
    "kind": "clef",
    "accountId": "<32-character Cloudflare account ID>",
    "model": "clef"
  }
}
```

Import an image with `image_import` or `image-import`, then use its saved asset metadata in an image material. Provide factual `altText` and the exact authored `caption`; Sheg does not inspect an image to write these fields. Bind images to a question with `visual.mode: "pixels"` when the model must inspect pixels. Use `visual.mode: "described"` when the supplied description and caption are enough; that mode sends text and does not claim pixel inspection.

Bind only the images the question needs. Clef accepts at most four images in one provider call and at most 64 questions. Sheg orders attachments by the material order frozen in the study request. A pixel Choice question may set `materialOptions` so each stable option ID explicitly identifies its image material; each mapped image must also appear in that question's pixel binding. Sheg includes those option-to-image mappings in the provider prompt. An image answer does not become text `selectedMaterial` evidence for follow-on reuse.

For an article journey, bind an image only on the stage where it is shown. Later text stages receive a compact record of the supplied description, caption, typed response, provider, model, and material identity. They do not receive image bytes again unless a later task explicitly binds that image. Agents can use the same rule to ask a separate question about a deliberate repeat exposure.

## Inspect and run

Use `run_inspect` or `sheg inspect` before accepting a study. Inspection is keyless and does not call Clef. It resolves saved image bytes, verifies their digests, checks image dimensions and request size, and reports the conservative fit estimate. The same admission checks run again when a study is accepted.

Sheg currently enforces four images per call, 4 MiB per image, 8 MiB total decoded image data, 16 megapixels per image, and a 13 MiB serialized request body. It estimates text as UTF-8 bytes divided by three and budgets 1,027 input tokens per image, then reserves 20% of the 65,536-token context window. This intentionally conservative estimate may report no fit even when Cloudflare's image tokenizer would use fewer tokens. `maxBytes` on image scaling limits the saved image file; it does not establish that the complete Clef request will fit.

The image payload must be saved in Sheg before inspection and acceptance. MCP image file imports require an absolute path; CLI file paths in an image-import request resolve relative to that request file. After acceptance, Sheg retains exact imported bytes for the run, so deleting the source file does not change queued execution.

Clef bills input tokens, including image tokens, at the current model rate. Check Cloudflare's [Clef model page](https://developers.cloudflare.com/workers-ai/models/clef/) and your account dashboard for current pricing and usage. Sheg records provider-reported input usage when Cloudflare returns it; its admission estimate is not a price quote.

## Failure and evidence

Clef authorization failures stop the run until the credential or account access is repaired. A malformed answer remains local to its question when Cloudflare returns valid sibling answers. Sheg records the provider, served model, input usage, and physical attempt in run evidence. It does not retry by sending the study to another provider.

Use `run_get` with `view: "request"` to inspect the frozen packet, `view: "answers"` for typed outcomes, and `view: "attempts"` for physical provider execution evidence. A visual history event contains digests and authored descriptions, not image bytes or generated image interpretations.

See the [image preparation guide](../guides/image-preparation.md) for importing, scaling, and inspecting image assets.
