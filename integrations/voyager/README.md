# VOYAGER integration

This directory contains the local, opt-in paired-document workflow for the
VOYAGER resume design. It is intentionally separate from Career Ops' portable
HTML/PDF tooling because it requires a user-owned VOYAGER checkout at
`careers/VOYAGER/`, which is gitignored and never copied into generated output.

`build.mjs` compiles pre-rendered TeX with that checkout's `style.cls`.
`generate-documents.mjs` turns an approved, evidence-backed draft into a
matched resume and cover letter. The copied class inside each artifact bundle
makes later regeneration reproducible without modifying the source checkout.
