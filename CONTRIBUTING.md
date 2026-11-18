# Contributing

Issues and pull requests are welcome. This project is MIT licensed.

## Setup

Node.js 22 is the version the AI SDK declares. Node.js 20 is also exercised in CI.

```bash
npm install
npm test
npm run test:coverage
```

Coverage gates are 90% statements, branches, functions, and lines.

## Checks

```bash
npm run lint
npm run typecheck
npm run build
npm run playground:dry-run
```

`npm run bench` rewrites `bench/results.json` and `bench/RESULTS.md`. Those files are measurements. If you change the scenario, commit the new output and say what changed.

## Playground

```bash
npm run playground
```

Open http://127.0.0.1:4391. The worker uses mock models only. Do not add a provider SDK or an API key to it.

## Commit style

Write the subject in the imperative. Explain the behavior change, not the file list. Do not add `Co-authored-by` trailers.
