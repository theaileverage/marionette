# Captured Herdr protocol contract

`src/herdr-protocol.ts` is the captured TypeScript contract for Herdr 0.9.0,
protocol 22. Its declared schema SHA-256 is
`5fb46b13fdaf39c88cf699b9806685868c7ee6b0142523d84391b1606416dc0a`.
The source schema and generator are not part of this worktree. The release check
pins the protocol, hash, and 102 method names against
`vendor/herdr-0.9.0/contract.json`; it cannot independently regenerate or
authenticate that upstream schema hash.

To update the SDK, obtain the matching Herdr schema and generator, regenerate
the types, review the method and response changes, update the contract lock,
and run the package and live native checks separately. A packaged SDK import
proves only the package boundary, while a live Herdr check proves transport
compatibility with the server actually installed.
