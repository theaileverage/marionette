# Extension contract

An extension shares a pinned idea and its resources. Loading an extension does not execute code or grant permissions.

The first contract is a data-only descriptor. It has `apiVersion: 1`, a stable ID, a positive contract version, a summary, parent references, and content-addressed resources. Each parent reference pins an ID, version, and digest. Each resource has a normalized relative path, text, and a digest of those exact bytes. The descriptor digest covers the complete canonical descriptor.

An explicit catalog resolves exact references. There is no network discovery, dynamic import, shell command, or newest-version fallback. Resolution verifies the digest and all parent references. Duplicate versions, cycles, unsupported API versions, malformed paths, digest mismatches, and extra authority fields fail validation.

Parent resources are not merged implicitly. A derived idea identifies its parents and supplies its complete resource set. That rule makes a selected snapshot independent of catalog insertion order and avoids hidden overrides. Existing workflow packages remain the execution contract and retain their current validation and admission checks.

The catalog receives no database handle, actor token, native client, or write capability. An extension cannot alter a workspace boundary, assign a profile, accept a result, or authorize a native effect. A caller can inspect resolved resources and propose a job. The authenticated core must still admit that job under the user's authority.

This version supports sharing and deriving ideas without creating a plugin sandbox. Executable adapters remain explicitly installed application code with their existing invocation contract. A descriptor cannot make executable code trusted by declaring it read-only.
