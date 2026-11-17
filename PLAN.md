# PLAN — github-core-clone-01

Bounty: Build a GitHub-compatible git forge. Hadiah $500 (juara 1 $100, 20 tempat berbayar).
Deadline entri: 21 Nov 2026 13:30 WIB (2026-11-21T06:30:00Z).
Akun: make.fun @steady-robin-15, wallet payout `6aT4QgwW4BcRNth4cVeXSkQ6kfmo2cxtAheAVsCk6TG1`.
GitHub: zasage (gh CLI login). Repo: https://github.com/zasage/github-core-clone-01
Kompetisi dibuka: 2026-11-14T06:30:00Z. Repo dibuat setelah pembukaan. Prize TIDAK di-escrow (dibayar transfer USDC Solana; submit repo GitHub tanpa signature).

## Skor (0–1000)
- Feature 600 = round(600 × lolos/120) atas 120 conformance check: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5. House reference lolos 120/120.
- Agent-native 200 = round(200 × lolos/15) atas check MCP.
- Perf 200 = 4 workload × maks 50 poin: clamp(25 − 12.5·log2(t/T_ref), 0, 50).
  T_ref (median house di production): push 1640.82 ms, clone 266.941 ms, read 2759.715 ms, write 348.965 ms.
  Di T_ref tiap workload = 25 poin (total 100/200); setengah T_ref = 38; seperempat = 50.
- Hadiah butuh skor STRICTLY di atas house reference (seri statistik tidak cukup) + masuk 60 besar kualifikasi + top 20 final.
- Replay final harus byte-identik → JANGAN pakai wall clock / Math.random di respons apa pun.

## Arsitektur (satu proses, Node 22, stdlib saja — tanpa git binary, tanpa network)
- `main.ts`: lifecycle kit (jangan diubah): listen(0) → POST $MAKEFUN_ENV_URL/register {port} → poll GET /done → exit 0.
- `app.ts`: HTTP server (node:http). Router ke 4 permukaan, semua di atas satu Store.
- Store in-memory (Map): repo, ref, objek git, issue, label, PR, comment. Persistensi tidak perlu (trial 900 detik, satu proses).
- Jam deterministik: basis `MAKEFUN_TRIAL_NOW` (atau epoch tetap bila tak ada) + counter monotonik per mutasi. Semua `created_at`/`updated_at`/tanggal commit dari jam ini — replay-identik.
- Objek git: format asli (`"<type> <len>\0" + body`, SHA-1). Packfile tulis: objek penuh saja (tanpa delta — valid). Packfile baca: WAJIB dukung delta (OBJ_OFS_DELTA + OBJ_REF_DELTA, apply delta) karena client suite kemungkinan mengirim pack berdelta.

## Permukaan (lihat docs/CHECKS.md untuk inventaris cek persis dari source suite)
1. **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (advertisement `version 2`, ls-refs, fetch; **haves WAJIB dihormati — JANGAN kirim ulang objek yang dimiliki client**: cek `fetch-incremental` gagal bila objek lama dikirim ulang, `fetch-nothing-new` mengharapkan 0 objek terkirim; thin-pack diminta default oleh client v2, tapi server BOLEH mengirim objek penuh saja asalkan mengecualikan haves; dukung `deepen` + `shallow`/`unshallow`), receive-pack v0 (advertise report-status + side-band-64k + delete-refs; fast-forward only, non-FF → `ng <ref> non-fast-forward` per ref, ref lain tetap diterapkan). GET /info/refs dengan preamble `# service=...`; repo hilang → 404, server tetap hidup. Detail persis: docs/CHECKS.md §3 + §8 Q4. **KOREKSI 2026-11-17: instruksi lama "haves selalu dijawab NAK" SALAH dan sudah dicabut.**
2. **REST v3** (`/api/v3`): repo (CRUD + contents PUT/DELETE + labels), issue (+ label wajib ada dulu, 422 bila label tidak ada), PR (+ merge → squash commit di default branch). Setiap balasan: `application/json`, header `X-GitHub-Request-Id` non-empty, error JSON `{message}`. Auth: `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; tanpa token → 401; repo di bawah owner lain → 404 (bukan 403). Route tak dikenal → 404 JSON; body JSON rusak → 400.
3. **GraphQL** (`POST /api/graphql`): introspeksi untuk Issue (id, number, title, state, body), PullRequest (id, number, headRefName, baseRefName, mergeable, state, merged, files), Repository (id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest); SearchType enum memuat ISSUE. `repository.issues(orderBy CREATED_AT DESC)` urut nomor DESC; `states:[OPEN]` menghilangkan yang closed. `createPullRequest` dari branch yang sudah di-push. Dua dokumen dalam satu body → dua hasil berurutan. Field tak dikenal → HTTP 200 + `errors`. Repo tak dikenal → `data.repository = null`, tanpa errors.
4. **MCP** (`POST /mcp`): JSON-RPC 2.0 Streamable HTTP, revisi 2026-07-28 (atau handshake 2025-11-25). `tools/list` ≥ 6 tools: create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request (prefix `github__` boleh, dicocokkan sebagai suffix case-insensitive). Dua `tools/list` berurutan jawabannya byte-identik. Dua `tools/call` bersamaan harus menjawab sesuai id masing-masing. Tool tak dikenal → -32602/-32601 (bukan HTTP 500); argumen wajib hilang → isError:true atau -32602; body bukan JSON → HTTP 400 -32700; tanpa Authorization → 401. Tool bekerja pada store yang sama dengan REST (id tidak berubah antar baca).

## Workload perf (median 3 ronde, setelah 5 warm-up)
- push: 200 push perubahan 1 KiB ke satu repo, berurutan.
- clone: 50 shallow clone (depth 1) bersamaan atas repo 200 commit.
- read: 2.000 GET issue berurutan, satu koneksi keep-alive.
- write: 200 buat issue berurutan.
- Target: kejar ≤ T_ref tiap workload (25 poin) — syukur di bawahnya. Store in-memory + respons JSON minimal + keep-alive adalah kuncinya.

## Urutan implementasi (bobot dulu)
1. Lifecycle + Store + REST repo/contents (fondasi semua permukaan).
2. Git objects + packfile baca/tulis + receive-pack (push) — tanpa ini repo kosong.
3. upload-pack v2 (clone/fetch) — tanpa ini push tidak bisa diverifikasi suite.
4. REST issues/labels/pulls (+ merge squash).
5. GraphQL.
6. MCP.
7. Perf tuning + uji lokal penuh.

## Pengujian lokal (tanpa Docker — Docker TIDAK ada di VM ini)
- `grade-local --driver docker` TIDAK bisa jalan. Cara uji: jalankan env suite langsung (`program/env/server.mjs`) sebagai proses Node + forge kita sebagai proses Node di mesin ini, dengan MAKEFUN_ENV_URL + MAKEFUN_SHOP_TOKEN yang sama. Scout (docs/CHECKS.md) mencatat cara persisnya.
- Uji unit tiap permukaan dengan client git asli (`git clone/push` via http) dan curl.
- Determinisme: jalankan suite 2×, bandingkan export (harus identik).

## Pembagian kerja
- Scout: docs/CHECKS.md — inventaris cek persis dari program/env/src/*.ts + cara jalanin suite lokal.
- Worker A (git): src/git/*.ts — object store, packfile, upload-pack v2, receive-pack v0.
- Worker B (rest): src/store.ts + src/rest.ts — Store + REST v3.
- Worker C (api): src/graphql.ts + src/mcp.ts — GraphQL + MCP.
- Koordinator: wiring app.ts, integrasi, uji lokal, laporan.

## Hasil lokal (koordinator, 2026-11-17) — VERIFIED
- Suite lokal `sdk/run.ts --perf` (2×, server fresh): **120/120 cek lolos** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15) — **feature 600, agent 200, perf 184 (run 1) / 187 (run 2), skor 984 / 987, working 1**. Hasil cek identik di kedua run (deterministik).
- `grade-local --driver process` (trial penuh, commit 09217d9): **status finished, skor 983 (feature 600, agent 200, perf 183), working 1, nondeterministic 0, timeout 0, spend $0**. `l1.reproduced: true`. State export sha256 `a0e98d49…` — **byte-identik dengan export house reference** (calibration.json).
- Perf lokal vs T_ref: push p50 ~320 ms (T_ref 1641), clone ~106 ms (267), read ~714 ms (2760), write ~131 ms (349) — 2,5–5× lebih cepat dari T_ref di VM ini. Di production (node shared, lebih berisik) akan melambat, tapi margin besar.
- Uji tambahan: git CLI asli (clone/push/shallow/tag/non-FF) lolos; suite git-client 21/21; REST + GraphQL + MCP 38/38 (Worker C).
- README sudah pakai template badge make.fun (owner zasage, referral w9cz8q8t); repo About terverifikasi: homepage https://make.fun/bounty/github-core-clone-01, topics [makefun].
- Koreksi penting selama build: instruksi awal "haves selalu NAK" SALAH — server wajib menghormati haves + thin-pack (CHECKS.md §3/§8); owner token = `adaiversen` (id 1000, diverifikasi via buildScenario()); MCP initialize memakai 2025-11-25 dulu.
- Sisa untuk parent: bundle transkrip + `makefun check` + submit (JANGAN dilakukan koordinator). Risiko kecil: kode belum diuji di Node 22 persis (VM ini Node 24; server trial Node 22) — hanya stdlib umum yang dipakai, tapi belum ada bukti runtime Node 22.

## Transcript (W AJIB dipatuhi semua worker)
- Kerja HANYA di dalam ~/workspace/makefun/github-core-clone-01 (agar sesi terekam sebagai sesi repo ini).
- Jangan pakai sesi handed-over. Jangan menulis ulang/rebuild sesi.
- Prompt pembuka run: pesan kak "Lanjut ke bounty berikutnya" + "Gas semua aja" (parent yang akan bundle saat submit).
- Bundle/transcripts + check + submit dilakukan parent (koordinator utama). Worker JANGAN submit.
- File baru ditulis lewat tool write/edit (bukan cp dari kit — baris dari starter dikecualikan dari hitungan authored, tapi kode kita harus ditulis agent).
