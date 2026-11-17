# CHECKS.md — Inventaris lengkap suite penilaian github-core-clone-01

> **Sumber:** dibaca langsung dari source kit di
> `~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit/`:
> `program/env/src/{checks-git,checks-rest,checks-graphql,checks-mcp,bench,wire,git-client,rest-client,graphql-client,mcp-client,export,manifest,main}.ts`,
> `program/env/src/calibration.json`, `program/scorer/{score,columns,main}.ts`,
> `rules/instance.yaml`, `RULES.txt`, `program/env/server.mjs`, `sdk/run.ts`,
> `cli/makefun.mjs --help`.
> Nilai-nilai scenario di bawah ini **dihitung** dengan menjalankan
> `buildScenario()` dari `program/env/src/wire.ts` (Node 24,
> `--experimental-strip-types`), bukan ditebak.
>
> **Total: 120 cek** — git 30, repos 15, issues 15, pulls 20, graphql 20,
> mcp 15, protocol 5. Skor: feature = round(600 × lolos/120), agent =
> round(200 × lolos MCP/15), perf = Σ workload
> round(clamp(25 − 12,5·log2(t/T_ref), 0, 50)), total 0–1000. Tie-break:
> `perf_p50_us` menaik, lalu receipt lebih awal.

## 0. Data scenario (seed tetap — semua nama/isi/byte berasal dari sini)

Seed: `SCENARIO_SEED = 0x6a09e667f3bcc909` (`"6a09e667f3bcc909"`),
epoch `SCENARIO_EPOCH_SEC = 1735689600` (2025-01-01T00:00:00Z).
Tidak ada `Date.now()` / `Math.random()` dalam data apa pun.

| Item | Nilai (dihitung dari `buildScenario()`) |
|---|---|
| Viewer (pemilik token) | `adaiversen`, id 1000, `ada iversen <adaiversen@example.invalid>` |
| Teammate | `quinnkeller`, id 1001 |
| Stranger (owner lain) | `olgabauer`, id 1002, `olga bauer <olgabauer@example.invalid>` |
| Org | `faint-meadow-org` |
| Repo viewer pertama | `amber-thistle` (id 5000), deskripsi `the tooling behind the thing`, `private: false`, default branch `main` |
| 30 repo viewer (untuk paginasi) | `amber-thistle, happy-willow, happy-ember, crisp-thistle, nimble-delta, tidy-harbor, quiet-orchid, gentle-quartz, happy-nebula, witty-thistle, upbeat-yarrow, faint-falcon, quick-juniper, tidy-umber, eager-pebble, warm-raven, idle-badger, calm-orchid, tidy-ember, brisk-cedar, steady-meadow, idle-lantern, quick-raven, plain-cedar, calm-quartz, tidy-lantern, happy-thistle, crisp-zephyr, keen-glade, amber-badger` |
| Repo stranger (3) | `gentle-comet, faint-raven, upbeat-orchid` |
| Label | `bug, enhancement, documentation, question, good first issue, help wanted` |
| Branch scenario | `main, develop, release/1.0, docs/graphql-cursor-pagination, feature/issue-label-validation, feature/push-report-status-checks, fix/repo-pagination, perf/issue-label-validation, docs/repo-pagination, perf/conditional-requests-2, fix/shallow-fetch-support` |
| Blob 0 / 1 | `config/token.css` (isi diawali `lichen\nkelp victor…`), `server.toml` (diawali `nickel\ncharlie…`) |
| Issue template 0 / 1 | `Incorrect GraphQL node ids` / `Stale push report-status` |
| Pull template 0 / 1 / 2 | head `chore/mcp-tool-schemas` / `chore/conditional-requests` / `feature/repo-pagination`, base `main` |
| Commit template 0 | `Tidy issue pagination`, author `adaiversen`, epochSec `1739175597`, `+0000` |
| Identitas commit git checks | `<nama viewer> <email viewer>` = `ada iversen <adaiversen@example.invalid>`, timestamp = epochSec commit template + revisi |
| Identitas commit bench/fixture | `Conformance <conformance@make.fun>` (`CONFORMANCE_IDENTITY`), epoch bench `1700000000`, epoch fixture GraphQL `1735689600` |

**Konvensi penamaan repo per grup cek** (repo dibuat lewat REST, nama
deterministik dari seed):

- git: `gitconf-<slug>` di bawah owner `adaiversen`
  (mis. `gitconf-clone-empty`).
- REST: `<repoPrefix>-<slug>` dengan repoPrefix = `amber-thistle`
  (mis. `amber-thistle-repos-create`); nama dipotong maks 100 karakter.
  Paginasi memakai 30 nama repo viewer di atas apa adanya.
- GraphQL: `amber-thistle-graphql`, `amber-thistle-graphql-pages`,
  `amber-thistle-graphql-missing`.
- MCP: `mcp-6a09e667-<part>` (tag = 8 hex pertama seed), mis.
  `mcp-6a09e667-issue-create`; branch `mcp-head-6a09e667-<part>`;
  file `mcp-6a09e667-<part>-<which>.txt`.
- Bench: `bench-push`, `bench-clone`, `bench-read`, `bench-write`.

**Timeout per cek:** default 15.000 ms, min 5.000, maks 15.000
(`CHECK_TIMEOUT_MS/MIN/MAX`, `wire.ts`). Timeout per cek tercantum di
bawah; timeout → bit 0 dengan detail `deadline`, cek lain tetap jalan.
Semua cek jalan **satu per satu, berurutan** (tidak ada paralelisme antar
cek; hanya workload `clone` yang paralel di dalam dirinya).

---

## 1. Cara menjalankan suite secara lokal TANPA Docker

Docker **tidak ada** di VM ini dan **tidak dibutuhkan**. Ada dua rute,
keduanya terverifikasi dari source (rute A dari `sdk/run.ts`, rute B
di-smoke-test langsung dengan `node`).

### Rute A (disarankan untuk menguji forge): `sdk/run.ts`

```bash
# 1. Jalankan forge lokal di satu port, mis. 18080, dengan token apa pun
#    (forge harus memetakan token itu ke login "adaiversen" — lihat §8 Q1).
#    Forge harus menjawab GET /healthz dengan 200.
# 2. Jalankan suite dari kit:
cd ~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:18080 --token TESTTOKEN [--perf] [--json] [--timeout-ms N]
```

Perilaku persis (`sdk/run.ts`, Node ≥ 22.6 untuk `--experimental-strip-types`;
VM ini Node v24.22.1 — perintah di atas sudah dipakai untuk menghitung
scenario, jadi flag ini bekerja):

- Probe `GET /healthz` **sekali** (timeout 5 detik). Gagal → exit 1,
  tidak ada cek yang jalan. Berhasil → exit 0 apa pun hasil ceknya
  (cek gagal dilaporkan di tabel, bukan via exit status).
- Menjalankan 120 cek dalam **urutan registrasi yang sama** dengan env
  (`[...GIT_CHECKS, ...restChecks(), ...restProtocolChecks(),
  ...GRAPHQL_CHECKS, ...MCP_CHECKS]`), satu per satu, tiap cek dengan
  timeoutnya sendiri (clamp 5–15 dtk; `--timeout-ms` membatasi atas).
- Menginstal git fixture GraphQL (`configureGraphQLGit` +
  `createGitFixture`) sebelum cek berjalan — sama seperti env.
- `--perf`: menjalankan juga 4 workload bench dan menambah poin perf.
- `--json`: mencetak satu objek JSON (counts per grup, semua baris cek,
  kolom, dan objek `perf`) alih-alih tabel.
- Tanpa `--perf`, kolom perf = 0 dan dicetak `(not run: pass --perf)`.
- Kolom yang dicetak: `checks: N registered of 120; P passed`,
  `feature = round(600*P/120)`, `agent = round(200*MCP/15)`,
  `score of 1000; working 0|1` (`working` = 1 bila ada ≥ 1 cek lolos).
- **Perbedaan vs trial resmi:** tidak ada register/done, tidak ada
  phase budget, tidak menulis `export/state.json`/`perf.json`, healthz
  sekali (env: dua kali), dan tidak ada replay. Hijau di sini = bukti,
  bukan jaminan nilai final.

### Rute B (env resmi penuh): `program/env/server.mjs`

`server.mjs` adalah bundle esbuild mandiri (satu file ESM, tanpa
dependensi, `node:fs` + `node:http` saja; di ujung file:
`var code = await main(); process.exit(code);`). **Bisa dijalankan
langsung dengan `node`** — terverifikasi 2026-11-17 dengan smoke test:
`MAKEFUN_STATE_DIR=/tmp/env-smoke MAKEFUN_ENV_HOST=127.0.0.1
MAKEFUN_ENV_PORT=0 MAKEFUN_SHOP_TOKEN=test-token-123 timeout 6 node
program/env/server.mjs` → menulis `/tmp/env-smoke/ready`
`{"schema":"github-core-clone-01/ready/v1","host":"127.0.0.1","port":46309}`
(port 0 → port bebas) dan `calls.ndjson` kosong, lalu menunggu register
(sampai boot budget 20 dtk).

```bash
export MAKEFUN_STATE_DIR=/tmp/state          # default /state (di container)
export MAKEFUN_ENV_HOST=127.0.0.1            # default: 127.0.0.1 bila MAKEFUN_STATE_DIR diset
                                             # (process driver), else 0.0.0.0 (container)
export MAKEFUN_ENV_PORT=8080                 # default 8080; 0 = port bebas
export MAKEFUN_SHOP_TOKEN=<token>            # token yang disajikan ke entry
export MAKEFUN_TRIAL_WALL_BUDGET_SEC=900     # opsional; default 900
node ~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit/program/env/server.mjs
```

Env lalu: listen → tulis `<state>/ready` → tunggu entry `POST
$MAKEFUN_ENV_URL/register {"port": N}` (pertama menang; kedua → 409)
→ boot: `GET /healthz` 2× dalam 10 dtk → instal git fixture → 120 cek
→ 4 workload → tulis `export/state.json` lalu `export/perf.json`
(atomik: file tmp + fsync + rename; file yang sudah ada di disk dan
"tidak lebih buruk" dipertahankan) → `GET /done` menjawab
`{"done": true}`. SIGTERM menulis ulang export bila belum ada yang lebih
baik, lalu exit 0. Deadline internal = start + wallBudget − 90 dtk
(`DEADLINE_MARGIN_MS`); setelah itu cek tersisa = 0 `deadline`, export
tetap ditulis, proses exit setelah grace 5 dtk.

**Entry (forge) harus:** bind port ephemeral (`listen(0)`, JANGAN 8080),
`POST $MAKEFUN_ENV_URL/register {"port": N}`, lalu long-poll
`GET $MAKEFUN_ENV_URL/done` (interval 250 ms → maks 2 dtk) sampai
`{"done": true}`, lalu exit 0. Tidak register sebelum boot budget (20 dtk)
= boot failure: semua cek 0, `working` 0.

### Rute C (opsional): `grade-local --driver process`

```bash
node cli/makefun.mjs grade-local --kit <dir-kit> --bot <path-repo-entry> --driver process [--save <dir>]
```

Dari `cli/makefun.mjs --help`: untuk kit agent/v1, trial berjalan di
`practice/trial-0/` secara live, lalu **replay check** (kaset diputar
ulang tanpa model; `state.json` harus byte-identik). Di bawah
`--driver process`, env, forwarder, dan agent berjalan di mesin ini
tanpa isolasi, di port loopback, tanpa trial network — **tanpa Docker**.
Hasilnya advisory, bukan vonis grader. Kompetisi ini
(`model_calls: optional`, tanpa target) tidak butuh API key model bila
entry tidak memanggil model. Rute ini **belum dieksekusi** di VM ini
(dokumentasi dari teks `--help` saja) — untuk menguji forge, Rute A
sudah cukup; Rute C berguna untuk memeriksa replay.

---

## 2. Urutan suite (jawaban Q7)

`main.ts runSuite()` → `suiteChecks()`:

1. **Ready + boot** (budget 20 dtk): tunggu `<state>/ready` terbaca
   kembali (30 dtk) → tunggu register pertama → `GET /healthz` 2×
   (budget 10 dtk). Gagal → `finishSuite` langsung: semua cek 0,
   `working` 0, note `BOOT_FAILED_NOTE`, export tetap ditulis.
2. **Instal git fixture GraphQL** (`configureGraphQLGit` atas `GitClient`
   env; bila gagal → adapter null dan 4 cek PR GraphQL gagal dengan
   detail jelas, 16 cek GraphQL lain tetap jalan).
3. **Conformance** (budget 240 dtk), satu per satu, urutan registrasi:
   `git` (30) → `repos` (15) → `issues` (15) → `pulls` (20) →
   `protocol` (5) → `graphql` (20) → `mcp` (15). Di dalam `restChecks()`,
   `repos.pagination` berjalan **pertama** (sengaja: agar repo lain
   belum dibuat sehingga hitungan 30 repo paling ketat). Detail urutan
   per grup ada di §3–§7.
4. **Benchmark** (budget 240 dtk): `push` → `clone` → `read` → `write`
   (lihat §7). Workload yang tidak sempat jalan → sentinel p50 1e9,
   0 poin.
5. **Export**: `export/state.json` dulu, lalu `export/perf.json`
   (canonical JSON: key terurut di semua kedalaman + satu newline
   akhir). `state.json` hanya berisi bit 0/1, counts, `perfTiers`
   **statis `{push:0, clone:0, read:0, write:0}`** (bukan band terukur —
   supaya replay byte-identik), `working` (1 bila boot OK dan ≥ 1 cek
   lolos), notes. `perf.json` berisi rounds/p50/p99/points/tiers,
   `perf_p50_us`, `points_total`.
6. **`/done` → `{"done": true}`**; proses tetap melayani sampai SIGTERM
   (atau exit setelah grace 5 dtk bila deadline jatuh).

Skoring (`program/scorer/score.ts` + `columns.ts`): membaca kedua file
export; file hilang/rusak → 0 di semua kolom dengan note (bukan throw).
`feature = round(600·passed/total)`, `agent = round(200·passedMcp/totalMcp)`,
`perf = perf.json points_total`, `score = feature+agent+perf`,
`working = 1` bila export `working==1` dan `passed>0`. `counts` di
`state.json` di-cross-check terhadap bit cek (counts.total tidak boleh
melebihi jumlah id; passed tidak boleh melebihi jumlah bit 1).

---

## 3. Grup `git` — 30 cek (smart HTTP; `checks-git.ts`)

**Client (`git-client.ts`):** base path `/{owner}/{repo}.git`
(owner/repo harus `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, repo tidak boleh
berakhiran `.git`). Header tiap request git: `User-Agent:
makefun-git-client/1.0`, `Authorization: Bearer <token>`,
`redirect: 'error'` (redirect tidak diikuti), timeout default 8000 ms.
`Accept: */*` untuk info/refs; POST memakai
`Content-Type: application/x-<service>-request` dan
`Accept: application/x-<service>-result`.

**Setup umum tiap cek:** `harness()` membuat `GitClient` lalu
`createRepo` via REST `POST /api/v3/user/repos` body
`{name, description: "git conformance for <owner>/<name>", private: true,
auto_init: false}` → 201/200 OK; 422 yang badannya mengandung
"already exists" diterima (idempotent). `repoWithInitialCommit()`: 1
commit (1 file scenario) di-push ke `refs/heads/main` dari
`ZERO_OID` (`"0"×40`). Commit dibangun lokal: `tree <oid>\n` +
`parent …\n` (bila ada) + `author <nama> <email> <epoch> +0000\n` +
`committer …\n\n<message>\n`; tree: entri terurut (nama dir dibandingkan
dengan `/` di akhir), mode file `100644`, dir `40000`; blob/tree/commit
SHA-1 atas `"<type> <len>\0" + body`.

**`pushRefs()` (helper):** sebelum push, `GET` advertisement
receive-pack, lalu menghitung objek yang sudah ada di server dari
tips yang diiklankan (via lookup lokal; bila ada tip yang tidak bisa
diurai lokal → anggap server tidak punya apa-apa). Hanya objek yang
reachable dari tip baru DAN belum ada di server yang dikirim
(`objectsToSend`). Pack yang dikirim client selalu **pack v2 tanpa
delta** (objek penuh, `deflateSync` per objek, trailer = SHA-1 dari
semua byte sebelumnya).

**Push (`client.push`):** advertisement receive-pack **harus v0**
(bukan v2). Capabilities yang dikirim di baris perintah pertama
(setelah NUL): `report-status-v2` bila ditawarkan else
`report-status`, `side-band-64k` bila ditawarkan, `ofs-delta` bila
ditawarkan, `agent=makefun-git-client/1.0` bila ditawarkan. Baris:
`<oldOid> <newOid> <ref>` + `flush`, lalu pack. **Pack selalu ada**
untuk create/update (bahkan pack kosong) — delete-only tanpa pack.
Respons di-demux sideband: band 1 = report-status, band 2 = progress,
band 3 = error (throw). Report-status diparse: baris `unpack ok|…`,
`ok <ref>`, `ng <ref> <reason>`, `option <k> <v>`; tanpa baris `unpack`
→ throw. Penolakan dikembalikan sebagai `report`, bukan throw.

**Fetch v2 (`fetchV2`):** `POST /{o}/{r}.git/git-upload-pack` dengan
header `Git-Protocol: version=2`. Body pkt-line (berurutan):
`command=fetch`, `agent=makefun-git-client/1.0` (bila caps `agent`),
`object-format=sha1` (bila caps `object-format`), `delim`,
`thin-pack` (**default aktif**; hanya hilang bila `thinPack: false`),
`no-progress` (**default aktif**), `ofs-delta`,
`filter <filter>` (bila ada), `want <oid>` per want,
`have <oid>` per have, `shallow <oid>` per boundary,
`deepen <N>` (bila `depth != null`), `deepen-since <ts>`,
`deepen-not <ref>`…, `done`, `flush`. Respons diparse per seksi:
`acknowledgments` (`NAK`/`ready`/`ACK …`), `shallow-info`
(`shallow …`/`unshallow …`), `wanted-refs`, `packfile` (sideband band
1 = data pack, band 2 = progress, band 3 = error). Pack harus lolos
verifikasi checksum trailer; bila `parse !== false`, pack diparse dan
delta (OFS/REF) di-resolve — basis thin-pack diambil dari
`request.haveObjects` (objek yang sudah dimiliki client).
Bila server tidak mengiklankan `shallow` pada `fetch` dan depth diminta
→ client throw (cek gagal, bukan salah server semata).

**Fetch v0 (`fetchV0`):** tanpa header `Git-Protocol`. Bila server
tidak mengiklankan `side-band-64k` → client throw (fetch tidak bisa
di-frame). Baris: `want <oid> <caps>` (caps hanya di baris want
pertama: `side-band-64k`, `multi_ack_detailed`/`multi_ack`,
`thin-pack` **hanya bila diiklankan**, `no-progress`, `ofs-delta`),
`shallow …`, `deepen N` (bila ada; butuh caps `shallow`), `flush`,
lalu `have …`, `done`, `flush` (dua seksi — satu seksi adalah bentuk
v2 dan membuat upload-pack menjawab error). Respons: paket sideband
langsung (band 1/2/3) plus baris `shallow`/`unshallow`/`NAK`/`ACK`.

**Clone (`client.clone`):** advertisement → bila v2, `lsRefs` dengan
`peel: true, symrefs: true`; bila v0, pakai daftar ref advertisement.
Wants: bila `depth != null` atau `singleBranch` → hanya tip HEAD
(symref target, atau refs/heads pertama); bila tidak → semua oid
`refs/heads/*` + `refs/tags/*` (lewati `ZERO_OID`). Repo kosong (0
want) → tidak fetch, 0 objek. `depth` diteruskan ke `fetch`.

**ls-refs v2:** `POST git-upload-pack` body pkt-line:
`command=ls-refs`, `agent=…`, `object-format=sha1`, `delim`,
`peel` (default aktif), `symrefs` (default aktif), `unborn` (bila
fetch caps mengandung `unborn`), `ref-prefix <p>` per prefix, `flush`.
Respons: `<oid> <ref> [symref-target:<t>] [peeled:<oid>]` atau
`unborn <ref>`.

### 3.1 Daftar 30 cek git (urutan jalan)

| # | ID | Timeout | Judul / yang dikirim → yang diharapkan |
|---|---|---|---|
| 1 | `git.advertise-v2` | 5000 | Setup 1 commit. `GET info/refs?service=git-upload-pack` (header `Git-Protocol: version=2`). Harap: protokol **2**; capabilities mengandung `fetch` dan `ls-refs`; `object-format` bila ada harus `sha1`. Gagal bila server menjawab v0. |
| 2 | `git.advertise-receive-pack` | 5000 | Setup 1 commit. `GET info/refs?service=git-receive-pack`. Harap: protokol **0**; refs memuat `refs/heads/main` di tip; capabilities mengandung `report-status`, `side-band-64k`, `delete-refs`. |
| 3 | `git.advertise-headers` | 5000 | Setup 1 commit. Tiga `info/refs`: v0 upload-pack (client `gitProtocol: 0`, tanpa header Git-Protocol), v2 upload-pack, receive-pack. Harap: ketiganya HTTP 200; Content-Type `application/x-git-upload-pack-advertisement` (2 pertama) / `application/x-git-receive-pack-advertisement`; body paket pertama v0 = `# service=git-upload-pack` (atau `version 2`), receive = `# service=git-receive-pack`, v2 = `version 2` (v0 diterima tapi dicatat sebagai milik cek advertise-v2). |
| 4 | `git.unknown-repo-404` | 5000 | Setup 1 commit. `info/refs` upload-pack + receive-pack untuk repo `<repo>-missing`. Harap: **keduanya 404**; setelah itu repo yang dikenal tetap 200 (server tetap hidup). |
| 5 | `git.ls-refs` | 8000 | Setup: main 1 commit → commit ke-2 + annotated tag `v1` (tag object atas commit ke-2) di-push. `ls-refs` (peel + symrefs). Harap: protokol 2; `refs/heads/main` = commit ke-2; `HEAD` dengan `symref-target: refs/heads/main`; `refs/tags/v1` = tag object dan `peeled` = commit ke-2. |
| 6 | `git.ls-refs-prefix` | 8000 | Setup: 1 commit + tag `v1`. `ls-refs` 3×: prefix `refs/heads/`, `refs/tags/`, `refs/does-not-exist/`. Harap: protokol 2; tiap jawaban hanya memuat ref dengan prefix itu; heads memuat main, tags memuat `v1`; prefix tak cocok → **0 ref**. |
| 7 | `git.clone-empty` | 8000 | Repo **baru tanpa push apa pun**. Advertisement + `ls-refs`. Harap: 0 ref `refs/*`; `clone()` → 0 objek, pack null/0 byte. HEAD unborn (bila diiklankan) diterima. |
| 8 | `git.push-first-commit` | 8000 | Push 1 commit `ZERO_OID → tip` ke `refs/heads/main` (unborn). Harap: `unpack ok`, report `ok refs/heads/main`; `ls-refs` sesudahnya: main = tip, HEAD symref → main. |
| 9 | `git.clone-object-hashes` | 12000 | 3 commit berantai (file revisi 0→1→2). Push tip ke-3. `clone()` penuh. Harap: semua objek recompute SHA-1 ke id-nya; tip ada; closure reachable lengkap; tidak ada objek reachable yang hilang. Detail menyebut jumlah objek, jumlah delta, byte pack. |
| 10 | `git.clone-blob-bytes` | 12000 | 2 commit; file pertama berukuran 4096 byte (revisi 0 lalu 1). Clone. Harap: semua objek reachable **byte-identik** dengan yang di-push (blob, tree, commit). |
| 11 | `git.clone-tree-entries` | 12000 | 1 commit, 4 file termasuk path bersarang (`src/<blob0>` bila blob0 tidak bersarang). Clone. Harap: entri root tree = tepat set direktori/file level-1 yang diharapkan; entri dir bermode `40000` dan isinya benar; semua tree byte-identik. |
| 12 | `git.clone-commit-bytes` | 12000 | 2 commit; commit ke-2 revisi 3. Clone. Harap: commit tip byte-identik; parents = [tip-1]; message sama persis (termasuk `\n` akhir); author & committer mengandung `<epoch> +0000` dan email viewer. |
| 13 | `git.clone-annotated-tag` | 10000 | 1 commit + annotated tag `v1`. Clone. Harap: tag object byte-identik; header `object`=tip, `type=commit`, `tag=v1`; tagger mengandung email viewer; `ls-refs` peel: `v1` peeled = tip. |
| 14 | `git.fetch-incremental` | 12000 | Clone penuh (tip-1), lalu push tip-2. `fetch {wants:[tip2], haves:[tip1], haveObjects: <obj clone>}`. Harap: tip-2 terkirim; **tip-1 TIDAK dikirim ulang**; semua objek baru yang reachable dari tip-2 ada; tidak ada objek lama yang dikirim ulang; hash semua objek fetch recompute benar. **Edge case kunci: server yang selalu NAK / mengabaikan `have` dan mengirim ulang semua → GAGAL** (cek `extraOld`). |
| 15 | `git.fetch-nothing-new` | 10000 | Clone penuh. `fetch {wants:[tip], haves:[tip], haveObjects}`. Harap: **0 objek** terkirim (pack boleh ada tapi tanpa entri). |
| 16 | `git.fetch-shallow-depth1` | 12000 | 3 commit berantai. `clone {depth: 1}`. Harap: hanya tip; parent & grandparent **absen**; commit tip byte-identik; tree tip + blob-nya ada; `shallow-info` menyebut tip. Request: `deepen 1`. |
| 17 | `git.fetch-shallow-deepen` | 12000 | 3 commit. `clone {depth: 1}`, lalu `fetch {wants:[tip3], haves:[tip3], shallow:[tip3], depth: 2, haveObjects}`. Harap: parent (tip-2) terkirim byte-identik beserta tree-nya; grandparent (tip-1) **tidak** terkirim; boundary bergerak (`shallow` menyebut tip-2 ATAU `unshallow` menyebut tip-3). Request: `deepen 2` + `shallow <tip3>`. |
| 18 | `git.fetch-shallow-new-tip` | 12000 | 2 commit, `clone {depth: 1}`, lalu push tip-3. `fetch {wants:[tip3], haves:[tip2], shallow:[tip2], depth: 1, haveObjects}`. Harap: tip-3 terkirim; tip-1 dan tip-2 **tidak** terkirim. |
| 19 | `git.push-update-ref` | 10000 | Push fast-forward tip-1 → tip-2 (`oldOid=tip1`). Harap: `unpack ok`, report ok; `ls-refs` main = tip-2; clone melihat tip-2. |
| 20 | `git.push-create-branch` | 10000 | Push `ZERO_OID → tip` ke `refs/heads/feature`. Harap: report ok; `ls-refs` memuat feature di tip; clone melihat feature. |
| 21 | `git.push-delete-branch` | 10000 | Buat `refs/heads/feature`, lalu push `tip → ZERO_OID` (delete; tanpa pack). Harap: report ok; feature hilang dari `ls-refs`; main utuh; repo tetap bisa di-clone. |
| 22 | `git.push-non-fast-forward` | 10000 | main di tip-2; push sibling (anak tip-1, bukan turunan tip-2) dengan `oldOid=tip2`. Harap: **unpack tetap ok** (pack diterima), report `ng refs/heads/main non-fast-forward` — alasan harus persis string `non-fast-forward`; main tetap tip-2; server tetap sehat (info/refs 200); clone melihat tip-2. |
| 23 | `git.push-mixed-report` | 12000 | main + side di tip-2. Satu push 2 perintah: main tip-2→forward (FF), side tip-2→sibling (non-FF). Harap: `unpack ok`; report **tepat 2 baris**: `ok refs/heads/main`, `ng refs/heads/side non-fast-forward`; hanya main yang maju, side tetap tip-2. |
| 24 | `git.push-delete-tag` | 10000 | Buat tag `v1`, lalu push `tag → ZERO_OID`. Harap: report ok; `refs/tags/v1` hilang; main utuh. |
| 25 | `git.push-100-files` | 15000 | Satu commit dengan **100 file** berbeda (path dari 60 filePaths scenario, diberi suffix `.1`, `.2`, … bila berulang). Push lalu clone. Harap: semua 100 file byte-identik, semua objek reachable ada; setiap path ditemukan dengan menelusuri tree clone. |
| 26 | `git.pack-integrity` | 12000 | 2 commit (blob 2048 byte). `fetch {wants:[tip2], parse:false}`. Harap: pack ada; **trailer SHA-1 = sha1(seluruh byte pack sebelumnya)**; header `PACK`, versi 2 atau 3; `declaredCount == jumlah entri terparse == jumlah objek unik`; semua objek recompute benar. |
| 27 | `git.pack-deltas` | 15000 | 4 commit berantai, tiap blob 20000 byte (revisi 0–3, konten hampir sama → rawan delta). Clone penuh. Harap: semua objek (termasuk yang ter-resolve dari delta) recompute benar dan byte-identik. Catatan: cek ini **tidak mewajibkan** server mengirim delta — hanya menuntut kebenaran bila server mengirimnya. |
| 28 | `git.sideband-framing` | 12000 | 2 commit (blob 4096 byte). `fetch {wants:[tip2], parse:false, observe: <kumpulkan paket>}`. Harap: tiap pkt-line ≤ 65520 byte (`PKT_LINE_MAX`); seksi `packfile` berisi paket sideband band 1 (data) / 2 (progress) saja — band 3 = gagal; band lain = gagal; ≥ 1 paket sideband; band-1 yang dirangkai membentuk pack valid dengan checksum benar. Seksi `acknowledgments`/`shallow-info`/`wanted-refs` dilewati; respons v0 (tanpa nama seksi) juga diterima. |
| 29 | `git.push-sideband-report` | 12000 | Push FF tip-1 → tip-2. Harap: server mengiklankan `side-band-64k` (`pushed.sideband` true); report-status ter-demux dari band 1; `unpack ok`; ref ok. Detail menyebut jumlah byte progress. |
| 30 | `git.repo-survives-errors` | 15000 | Urutan: info/refs repo hilang → 404; push FF OK; push non-FF (diterima ATAU ditolak — keduanya diterima di sini); `postRaw` ke `git-upload-pack` dengan body mentah `zzzznot-a-pkt-line` (bukan pkt-line; status apa pun dicatat, tidak dinilai). Harap sesudah semua itu: info/refs 200, `refs/heads/main` ada, clone lengkap dan semua hash benar. |

**Edge case umum git:** repo hilang → 404 di kedua service info/refs;
server harus tetap hidup setelah 404 / penolakan / request malformed.
Semua hash diverifikasi ulang oleh client (SHA-1 recompute); satu
objek yang hash-nya tidak cocok = gagal. Detail cek dibatasi 600
karakter.

## 4. Grup REST — repos 15, issues 15, pulls 20, protocol 5 (`checks-rest.ts`)

**Client (`rest-client.ts`):** prefix `/api/v3`. Header tiap request:
`Accept: application/vnd.github+json`; `Authorization: Bearer <token>`
(bila token ada); `Content-Type: application/json` bila ada body.
`redirect: 'follow'`; timeout default 5000 ms (cek memakai
`max(1000, min(timeoutMs, 5000))`); respons > 1 MiB dipotong.
Kegagalan transport/timeout → `status: 0` + `error` (cek gagal dengan
detail, bukan crash). URL `Link rel="next"` hanya diikuti bila
**satu origin** dengan base URL.

**Shape yang dipakai berulang:** `sha` = `/^[0-9a-f]{40}$/i`;
error body = `{message: string non-empty}`; `expectJsonResponse`
menuntut status persis + Content-Type JSON + body JSON valid + shape
(kelebihan properti dibiarkan kecuali dinyatakan). Body JSON malformed
dari server = gagal.

**Fixture umum:** `prepareRepo(set, id)`: `POST /user/repos`
`{name, private: true (default), description}` → 201
`{name, private}`; lalu `PUT /contents/<filePath>` (file pertama
scenario, konten `fileContent`) → 201 `{content:{sha, encoding:
"base64"}, commit:{sha}}`; lalu `GET` repo untuk membaca
`default_branch`. Repo tanpa commit pertama **tidak** dipakai di REST
(kecuali cek create/pagination/delete yang tidak butuh commit).
`createBranch`: `POST /git/refs {ref: "refs/heads/<branch>", sha}` →
201 `{ref, object:{sha}}`. `commitOnBranch`: `PUT /contents/<path>`
`{message, content: base64, branch}` (+ `sha` bila update) → 201
(200 juga diterima untuk update).

### 4.1 Grup `repos` — 15 cek (urutan jalan; `pagination` pertama)

| # | ID | Request persis → balasan diharapkan |
|---|---|---|
| 1 | `repos.pagination` | Buat 30 repo viewer (`POST /user/repos {name, private:true, description}` per nama; **201 OK, 422 diterima** bila sudah ada dari grup lain — lalu `GET` repo itu untuk memastikan ada). Lalu `GET /user/repos?per_page=10`; ikuti header `Link: <url>; rel="next"` selama ada (maks 20 halaman; next harus satu origin). Harap: tiap halaman ≤ 10 item; tidak ada nama yang berulang antar halaman; **semua 30 nama** muncul; **≥ 3 halaman**. |
| 2 | `repos.root` | `GET /api/v3/` → 200, body JSON object bebas (`looseObject`), header **`X-OAuth-Scopes` harus ada** (nilai tidak diperiksa). |
| 3 | `repos.meta` | `GET /api/v3/meta` → 200 `{installed_version: string non-empty}`. |
| 4 | `repos.create` | `POST /user/repos {name: "amber-thistle-repos-create", private: true, description: "the tooling behind the thing"}` → 201 `{name, private: true}`. Lalu `GET /repos/adaiversen/<name>` 2× → 200 `{name, private: true, default_branch: non-empty}`; `default_branch` harus **sama di kedua baca**. |
| 5 | `repos.not-found` | `GET /repos/adaiversen/amber-thistle-never-created` → **404** `{message: string}`. |
| 6 | `repos.patch` | `prepareRepo`; `PATCH /repos/{o}/{r} {description: "<desc> (updated)"}` → 200 `{description: "<desc> (updated)"}`; `GET` sesudahnya → description tetap yang baru. |
| 7 | `repos.delete` | `prepareRepo`; `DELETE /repos/{o}/{r}` → **204** (body tidak diperiksa); `GET` sesudahnya → **404** `{message}`. |
| 8 | `repos.branches` | `prepareRepo`; `POST /git/refs {ref: "refs/heads/<branchName>-branches", sha: <initialCommitSha>}` → 201; `GET /branches` → 200 array `[{name, commit:{sha}}]`; harus memuat branch baru **dan** default branch; sha branch baru = initial commit. Nama branch: `<branch scenario>-branches`, branch scenario diambil dari daftar branches yang bukan default dan tidak berakhiran `/`. |
| 9 | `repos.commits` | `prepareRepo`; buat branch, commit 1 file di branch itu (`PUT /contents/<path-varian> {branch}`); `GET /commits?sha=<branch>` → 200 array `[{sha, commit:{message}}]`; harus memuat commit itu dengan message persis `<commitMessage> (commits)`. `GET /commits` (tanpa `sha`) → **tidak boleh** memuat commit branch itu (belum merge). |
| 10 | `repos.unauthorized` | `prepareRepo` (private); `GET /repos/{o}/{r}` **tanpa token** (client `anon`, tanpa header Authorization) → **401** `{message}`. |
| 11 | `repos.foreign-token` | Buat repo `amber-thistle-repos-foreign` atas `adaiversen` → 201; `GET` atas `adaiversen` → 200; `GET /repos/olgabauer/amber-thistle-repos-foreign` (nama sama, owner stranger) dengan token yang sama → **404 `{message}` (bukan 403)**. |
| 12 | `repos.contents-create` | `prepareRepo`; `PUT /contents/<path>-created {message, content: base64(fileContentAlt)}` → 201 `{content:{sha, encoding:"base64"}, commit:{sha}}`; `GET /contents/<path>` → 200 `{type:"file", encoding:"base64", content, sha, size}`; konten ter-decode base64 harus sama dengan yang dikirim; `sha` GET = `content.sha` dari PUT; `size` = panjang byte konten. |
| 13 | `repos.contents-directory` | `prepareRepo` dengan file awal di `<dirPath>/seed.txt` (dirPath = direktori dari blob scenario yang mengandung `/`, mis. `config`); tambah `<dirPath>/one.txt` dan `<dirPath>/two.txt`; `GET /contents/<dirPath>` → 200 **array** `[{type: "file"\|"dir", name, path, sha}]`; harus memuat `seed.txt`, `one.txt`, `two.txt`. |
| 14 | `repos.contents-stale-sha` | `prepareRepo`; `GET` file → sha saat ini; `PUT` update dengan `sha` itu → 200/201 dan `content.sha` **berubah**; `PUT` lagi dengan sha **lama** → **409** `{message}`. |
| 15 | `repos.contents-delete` | `prepareRepo`; `GET` file → sha; `DELETE /contents/<path> {message, sha}` → 200 `{commit:{sha}}`; `GET` sesudahnya → **404** `{message}`. |

### 4.2 Grup `issues` — 15 cek

Fixture: `prepareIssueRepo`: `prepareRepo` + `POST /labels
{name: <label scenario, mis. "bug">, color: "ededed"}` → 201
`{name}`. Issue dibuat via `POST /issues {title, body, labels?}` →
201 `{number: int ≥ 1, title, body, state: "open"|"closed", labels:
[{name}]}`. `badLabel` = `"<label>-not-a-label"` (mis.
`bug-not-a-label`).

| # | ID | Request → harapan |
|---|---|---|
| 1 | `issues.create` | Buat issue (title + body scenario + labels `[label]`). Harap: 201, `state == "open"`. |
| 2 | `issues.create-title-body` | Buat issue tanpa label. Harap: `title` dan `body` persis sama dengan yang dikirim. |
| 3 | `issues.create-labels` | Buat issue dengan labels `[label]`. Harap: `labels[].name` memuat label itu. |
| 4 | `issues.numbers-increment` | Buat 2 issue berurutan di repo sama. Harap: number ke-2 = number ke-1 **+ 1**. |
| 5 | `issues.list-open` | Buat 1 open + 1 lalu di-close (`PATCH {state:"closed"}`); `GET /issues?state=open&per_page=100` → 200 array shape issue. Harap: memuat yang open; **semua** item ber-`state == "open"`. |
| 6 | `issues.list-open-excludes-closed` | Buat 1 issue lalu close; `GET /issues?state=open&per_page=100`. Harap: issue yang di-close **tidak** ada di daftar. |
| 7 | `issues.list-sort-asc` | Buat 3 issue (a, b, c); `GET /issues?state=open&sort=created&direction=asc&per_page=100`. Harap: posisi a < b < c. |
| 8 | `issues.list-sort-desc` | Sama dengan 3 issue; `direction=desc`. Harap: posisi c < b < a (terbaru dulu). |
| 9 | `issues.list-shape` | Buat 1 issue; `GET /issues?state=open&per_page=10`. Harap: ≥ 1 item; tiap item lolos shape `{number int≥1, title string, body string, state open\|closed, labels [{name}]}`. |
| 10 | `issues.get-one` | Buat issue; `GET /issues/{n}` → 200 shape issue; `number`, `title`, `body` sama dengan yang dibuat. |
| 11 | `issues.patch-close` | Buat issue; `PATCH /issues/{n} {state:"closed"}` → 200 `{number, state:"closed"}`. |
| 12 | `issues.patch-close-persists` | Buat + close; `GET /issues/{n}` sesudahnya → `state == "closed"` (tetap). |
| 13 | `issues.comment-create` | Buat issue; `POST /issues/{n}/comments {body: <commentBody = body issue template ke-2>}` → **201** `{id: int ≥ 1, body: <sama persis>}`. |
| 14 | `issues.comments-list` | Buat issue + 1 comment (201, catat `id`); `GET /issues/{n}/comments` → 200 array `[{id, body}]`; harus memuat comment itu (id + body cocok). |
| 15 | `issues.bad-label` | `POST /issues {title, body, labels: [badLabel]}` (label tidak pernah dibuat) → **422** `{message}`. |

### 4.3 Grup `pulls` — 20 cek

Fixture `preparePull`: `prepareRepo` → buat branch
`<branchName>-<slug>` dari initial commit (`POST /git/refs`) → commit
1 file varian di branch itu (`PUT /contents/<path>-<slug> {branch}`)
→ `POST /pulls {head: <branch>, base: <defaultBranch>, title, body}`
→ 201 `{number, state: "open"|"closed", title, body, head: {ref, sha},
base: {ref, sha}}`. `mergePull`: `PUT /pulls/{n}/merge
{merge_method: "squash"}`.

| # | ID | Request → harapan |
|---|---|---|
| 1 | `pulls.create` | Fixture PR; `GET /pulls/{n}` → 200 shape PR; `state == "open"`, `head.ref` = branch fixture, `base.ref` = default branch. |
| 2 | `pulls.create-body` | `GET /pulls/{n}` → `title`/`body` sama dengan yang dikirim saat create. |
| 3 | `pulls.create-head-sha` | `GET /pulls/{n}` → `head.sha` = tip commit branch head (sha commit contents di branch). |
| 4 | `pulls.create-base-sha` | `GET /pulls/{n}` → `base.sha` = initial commit (tip default branch). |
| 5 | `pulls.get-one` | `GET /pulls/{n}` → 200; `number` cocok; `title` cocok. |
| 6 | `pulls.files-list` | `GET /pulls/{n}/files` → 200 array `[{filename, status, additions, deletions, changes}]`; memuat path yang diubah; `status` ∈ `added`/`modified`/`changed`; `additions ≥ 1`. |
| 7 | `pulls.files-shape` | `GET /pulls/{n}/files` → ≥ 1 file; tiap item lolos shape: `filename` non-empty, `status` non-empty, `additions/deletions/changes` int ≥ 0. |
| 8 | `pulls.files-multiple` | PR dengan **2 file** diubah (varian `multi-a` + `multi-b`); `GET /pulls/{n}/files` → kedua path ada. |
| 9 | `pulls.merge-status` | `PUT /pulls/{n}/merge {merge_method:"squash"}` → **200** (status saja). |
| 10 | `pulls.merge-body` | Merge (squash) → 200 `{merged: true, sha: <sha40>, message: string}`; sha harus 40 hex. |
| 11 | `pulls.merge-closes` | Setelah merge, `GET /pulls/{n}` → `state == "closed"`, `merged == true`, `merged_at` string non-empty. |
| 12 | `pulls.merge-commit-on-default` | Setelah merge, `GET /commits?sha=<base>` → memuat merge sha. |
| 13 | `pulls.merge-content-on-default` | Setelah merge, `GET /contents/<changedPath>?ref=<base>` → konten ter-decode = isi file dari branch head (`fileContentAlt`). Jadi merge **squash** harus benar-benar memindahkan konten ke default branch. |
| 14 | `pulls.merge-commit-sha` | Setelah merge, `GET /pulls/{n}` → `merge_commit_sha` == sha dari jawaban merge. |
| 15 | `pulls.merge-unknown` | `PUT /pulls/999999999/merge {merge_method:"squash"}` di repo yang ada → **404** `{message}`. |
| 16 | `pulls.merge-conflict` | Repo + 2 branch (a, b) dari commit awal; **keduanya mengubah file yang sama** (`filePath` scenario) dengan konten berbeda (`… (a)` vs `… (b)`, via update dengan sha); buat PR a dan PR b; merge PR a → 200; merge PR b → **405** `{message}`. |
| 17 | `pulls.list-state-all` | 1 PR di-merge + 1 PR open (branch ke-2); `GET /pulls?state=all&per_page=100` → memuat **keduanya**. |
| 18 | `pulls.list-default-open` | Sama; `GET /pulls?per_page=100` (tanpa `state`) → memuat PR open, **tidak** memuat PR yang sudah merge. |
| 19 | `pulls.list-shape` | `GET /pulls?state=all&per_page=10` → ≥ 1 item; tiap item lolos shape PR (number, state open\|closed, title, body, head/base `{ref, sha}`). |
| 20 | `pulls.get-unknown` | `GET /pulls/999999999` → **404** `{message}`. |

### 4.4 Grup `protocol` — 5 cek (bagian REST; `restProtocolChecks()`)

| # | ID | Request → harapan |
|---|---|---|
| 1 | `protocol.content-type-json` | 6 panggilan: `GET /api/v3/`, `GET /api/v3/meta`, `GET <repo>`, `GET <repo>/issues`, `GET /api/v3/no-such-route-content-type`, `GET <repo>` **tanpa token**. Harap tiap balasan: Content-Type JSON (`application/json`, `application/vnd.github+json`, atau `+json` — dicek `isJsonContentType`), **bukan** `text/html`, dan body tidak diawali `<`. |
| 2 | `protocol.unknown-route-json-404` | `GET /api/v3/no-such-route/amber-thistle` → **404** `{message: string}` + bukan HTML. |
| 3 | `protocol.malformed-body-400` | `POST /user/repos` dengan body mentah `{"name":` (JSON tidak valid; header `content-type: application/json`) → **400** `{message}`. |
| 4 | `protocol.request-id` | 4 panggilan: `GET /api/v3/`, `GET <repo>`, `GET /api/v3/no-such-route-request-id`, `GET <repo>` tanpa token. Harap tiap balasan membawa header **`X-GitHub-Request-Id` yang ada dan tidak kosong**. (Format isi bebas — lihat §8 Q2.) |
| 5 | `protocol.error-message` | Tiga kasus: `GET` repo tak ada → 404 `{message}`; `GET` repo private tanpa token → 401 `{message}`; `POST /issues` dengan label tak dikenal → 422 `{message}`. |

**Tidak dipersyaratkan (sengaja):** header `X-RateLimit-*` apa pun
(tidak ada cek yang menuntutnya); nilai `X-OAuth-Scopes` (hanya
keberadaan); nilai `X-GitHub-Request-Id` (hanya non-empty).

## 5. Grup `graphql` — 20 cek (`checks-graphql.ts`)

**Client (`graphql-client.ts`):** `POST /api/graphql`, header
`Accept: application/json`, `Content-Type: application/json`,
`User-Agent: makefun-github-core-clone-env/1`,
`Authorization: Bearer <token>` (bila token non-null; `withoutToken()`
untuk cek 401). Body JSON `{query, variables}`; batch = array JSON
dari `{query, variables}` (boleh tambah `operationName`). Balasan
normal `{data, errors}`. Aturan: HTTP 200 yang membawa `errors`
adalah **kegagalan GraphQL** kecuali cek yang memang mengharapkannya
(hanya `invalid-field`); request tanpa token → **401**.

**Fixture** (dibangun malas, dipakai ulang antar cek; repo dibuat via
REST `POST /user/repos`, issue/PR via REST, branch via git adapter
`configureGraphQLGit` dari `main.ts` — commit fixture: epoch
`1735689600`, author `Conformance <conformance@make.fun>`,
message `fixture: …`):

- Repo: `amber-thistle-graphql` (private = private repo scenario
  pertama = `false`); repo halaman: `amber-thistle-graphql-pages`
  (private `false`); repo tak dikenal: `amber-thistle-graphql-missing`.
- `baseBranch` = `main`; `headBranch` = `chore/mcp-tool-schemas`
  (pulls[0].head); `createBranch` = `chore/conditional-requests`
  (pulls[1].head); `mergeBranch` = `feature/repo-pagination`
  (pulls[2].head).
- `filePath` = `config/token.css` (blobs[0]); `baseFilePath` =
  `server.toml` (blobs[1]).
- `titlePrefix` = `Incorrect GraphQL node ids` (issues[0].title);
  `body` = body issues[0]; `comment` = body issues[1].
- Issue fixture: 3 open (`"<prefix> open 1..3"`) + 1 closed
  (dibuat lalu `PATCH /issues/{n} {state:"closed"}` via REST).
- Pagination fixture: repo `-pages` dengan **tepat 7 issue**;
  `pageSize` 5.
- Cross-surface: semua hasil mutasi GraphQL diverifikasi ulang lewat
  REST (`GET /issues/{n}`, `GET /pulls/{n}`, `GET /issues/{n}/comments`).

### 5.1 Ke-18 dokumen GraphQL (disalin persis dari `checks-graphql.ts`)

Dokumen-dokumen ini adalah dokumen yang **gh** kirim (`api` package /
client githubv4-nya: `viewer`, repository fields, probe
`__type`, issue/PR reads, mutasi create/close/merge) dan bentuk yang
sama dipakai **github-mcp-server** — kit tidak memuat dokumen terpisah
untuk github-mcp-server (lihat §8 Q5 / §9).

```graphql
query ViewerLogin {
  viewer {
    login
  }
}
```

```graphql
query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}
```

```graphql
query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```

```graphql
query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```

```graphql
query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}
```

```graphql
query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}
```

```graphql
query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}
```

```graphql
mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}
```

```graphql
mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}
```

```graphql
query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}
```

```graphql
query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}
```

```graphql
query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}
```

```graphql
mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}
```

```graphql
mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}
```

```graphql
mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}
```

```graphql
query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}
```

```graphql
query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}
```

```graphql
query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

### 5.2 Daftar 20 cek graphql (urutan jalan)

| # | ID | Timeout | Dokumen + variabel → harapan |
|---|---|---|---|
| 1 | `graphql.viewer-login` | 8000 | `ViewerLogin`, `{}` → HTTP 200, tanpa `errors`; `data.viewer.login == "adaiversen"` (login pemilik token). |
| 2 | `graphql.repository-fields` | 10000 | `RepositoryFields`, `{owner:"adaiversen", name:"amber-thistle-graphql"}` → `data.repository.id` sama dengan id dari fixture (dibaca lewat query yang sama saat build fixture), `databaseId` int positif, `name` cocok, `owner.login == "adaiversen"`, `defaultBranchRef.name == "main"` (hanya dicek bila git adapter terinstal), `viewerPermission` ∈ `ADMIN/MAINTAIN/WRITE/TRIAGE/READ`, `hasIssuesEnabled == true`. |
| 3 | `graphql.introspection-issue` | 8000 | `Issue_fields`, `{}` → `data.Issue.fields` tidak kosong dan memuat `id, number, title, state, body`. |
| 4 | `graphql.introspection-types` | 10000 | `PullRequestAndRepositoryFields` + `SearchType_enumValues`, `{}` → `PullRequest.fields` memuat `id, number, headRefName, baseRefName, mergeable, state, merged, files`; `Repository.fields` memuat `id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest`; `SearchType.enumValues` memuat `ISSUE`. |
| 5 | `graphql.issues-open-order` | 12000 | `OpenIssues`, `{owner, name, first: 10}` → nodes ≤ 10; tiap node `state == "OPEN"`, punya `title` string dan `id` non-empty; **nomor urut menurun** (CREATED_AT DESC; seri diurutkan nomor DESC); issue closed fixture **tidak** muncul; ketiga issue open fixture muncul. |
| 6 | `graphql.issue-by-number` | 10000 | `IssueByNumber`, `{owner, name, number: <open[0]>}` → `number`, `state == "OPEN"`, `title == "Incorrect GraphQL node ids open 1"`, `body` = body scenario, `id` non-empty. |
| 7 | `graphql.create-issue` | 12000 | `IssueCreate`, `{input: {repositoryId: <id repo>, title: "Incorrect GraphQL node ids created over graphql", body: <body>}}` → `createIssue.issue.{number int>0, id non-empty}`; verifikasi REST `GET /issues/{n}` → number, title sama, `state == "open"`. |
| 8 | `graphql.close-issue` | 12000 | Buat issue via REST, baca id global-nya via `IssueByNumber`; `IssueClose`, `{input: {issueId: <id>}}` → `closeIssue.issue.{number cocok, state == "CLOSED"}`; REST `GET /issues/{n}` → `state == "closed"`. |
| 9 | `graphql.pull-requests-list` | 15000 | `PullRequests`, `{owner, name, first: 5}` → nodes ≤ 5; memuat PR fixture; `headRefName == "chore/mcp-tool-schemas"`, `baseRefName == "main"`, `state == "OPEN"`, `mergeable` ∈ `MERGEABLE/CONFLICTING/UNKNOWN`. |
| 10 | `graphql.pull-request-files` | 12000 | `PullRequestFiles`, `{owner, name, number}` → `pullRequest.number` cocok; `files.nodes[].path` memuat `config/token.css` (path yang diubah branch head). |
| 11 | `graphql.create-pull-request` | 15000 | `PullRequestCreate`, `{input: {repositoryId, baseRefName: "main", headRefName: "chore/conditional-requests", title: "<prefix> created over graphql"}}` → `pullRequest.{number, id, state == "OPEN", headRefName, baseRefName}` cocok; REST `GET /pulls/{n}` → `head.ref`/`base.ref` sama. |
| 12 | `graphql.merge-pull-request` | 15000 | Baca id PR fixture merge via `PullRequestId`; `MergePullRequest`, `{input: {pullRequestId: <id>, mergeMethod: "SQUASH"}}` → `pullRequest.{merged == true}`; REST `GET /pulls/{n}` → `merged == true`, `state == "closed"`. |
| 13 | `graphql.add-comment` | 12000 | Buat issue via REST, baca id-nya; `AddComment`, `{input: {subjectId: <id issue>, body: <comment = body issues[1]>}}` → `commentEdge.node.{id non-empty, body == comment}`; REST `GET /issues/{n}/comments` → memuat comment itu. |
| 14 | `graphql.invalid-field` | 8000 | `ViewerInvalidField`, `{}` → **HTTP 200** (bukan 400) dengan `errors` non-empty; salah satu pesan error harus mengandung `noSuchFieldOnViewer`. |
| 15 | `graphql.unauthenticated` | 8000 | `ViewerLogin` **tanpa token** (`withoutToken()`) → **HTTP 401**. |
| 16 | `graphql.node-repository` | 10000 | `NodeRepository`, `{id: <repo id>}` → `data.node.{id sama, name == "amber-thistle-graphql", nameWithOwner == "adaiversen/amber-thistle-graphql"}`. |
| 17 | `graphql.unknown-repository` | 8000 | `RepositoryFields`, `{owner:"adaiversen", name:"amber-thistle-graphql-missing"}` → HTTP 200, **tanpa `errors`**, `data.repository == null`. |
| 18 | `graphql.batched-operations` | 10000 | **Satu body HTTP = array JSON** `[{query: ViewerLogin}, {query: Issue_fields}]` (tanpa `variables` eksplisit; client mengisi `{}`) → HTTP 200, balasan array **tepat 2** entri berurutan; entri 1: `viewer.login == "adaiversen"`; entri 2: `Issue.fields` non-empty. |
| 19 | `graphql.global-id-stability` | 12000 | `RepositoryFields` 2× + `IssueByNumber` 2× (issue open pertama) → id repo **sama** di kedua baca dan **bukan** string `databaseId` mentah; id issue **sama** di kedua baca dan **bukan** string nomor issue mentah (id harus opaque). |
| 20 | `graphql.issues-pagination` | 12000 | `IssuesPage` halaman 1: `{owner, name:"amber-thistle-graphql-pages", first: 5, after: null}` → tepat 5 node, `pageInfo.hasNextPage == true`, `endCursor` string non-empty. Halaman 2: `{first: 5, after: <endCursor>}` → tepat 2 node, `hasNextPage == false`. Gabungan: 7 nomor **berbeda**, semuanya nomor issue fixture (7). |

**Edge case GraphQL:** `after: null` eksplisit di halaman pertama
(variabel nullable); enum inline (`states: [OPEN]`,
`orderBy: {field: CREATED_AT, direction: DESC}`); alias `Issue:` /
`PullRequest:` / `Repository:` / `SearchType:` pada `__type`;
`includeDeprecated: true` pada `fields`/`enumValues`; tanpa git
adapter, cek 2 melewati assert `defaultBranchRef`, cek 9–12 gagal
dengan detail "no git fixture provider was installed".

## 6. Grup `mcp` — 15 cek (`checks-mcp.ts` + `mcp-client.ts`)

**Transport:** `POST <base>/mcp`, JSON-RPC 2.0, Streamable HTTP.
Jawaban boleh `application/json` atau `text/event-stream` (SSE —
client membaca stream sampai data frame dengan id yang cocok).
**Tiap request harus dijawab dalam 3 detik**
(`MCP_DEFAULT_TIMEOUT_MS = 3000`).

**Dua era, satu client (`mcp-client.ts`):**

- **Modern (2026-07-28, preferred):** tanpa handshake, tanpa session.
  Tiap request membawa `_meta` dan header `MCP-Protocol-Version`.
  `server/discover` wajib menjawab `DiscoverResult` dengan
  `supportedVersions` (daftar revisi `YYYY-MM-DD` non-empty).
- **Legacy (2025-11-25 ke bawah):** `initialize` +
  `notifications/initialized`, opsional `Mcp-Session-Id`.
  `server/discover` yang dijawab 404 / 405 / JSON-RPC `-32601`
  (Method not found) = era pre-discover → fallback handshake.

**`connect()` (urutan persis):** `server/discover` dulu (id
`discover-1`, params `{}` + `_meta`). Bila OK → modern. Bila
`-32022` (UnsupportedProtocolVersionError) → coba lagi dengan versi
dari `data.supported` (preferred `2026-07-28` bila ada). Bila
method-not-found / 404 / 405 → legacy handshake. Bila penolakan lain
(401/403/5xx, `-32020` HeaderMismatch, `-32600`, `-32602`) → throw
(koneksi gagal, semua cek MCP yang memakai client itu gagal).

**Bentuk request JSON-RPC (persis):**

```json
{ "jsonrpc": "2.0", "id": <id>, "method": "<method>",
  "params": { /* params metode */ ,
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "<revisi>",
      "io.modelcontextprotocol/clientInfo": { "name": "makefun-github-core-clone-env", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
      "protocolVersion": "<revisi>"
    } } }
```

**Header tiap POST:** `Accept: application/json, text/event-stream`,
`Content-Type: application/json`,
`MCP-Protocol-Version: <revisi>` (kecuali `initialize` legacy:
`omitProtocolVersionHeader: true`), `MCP-Method: <method>`,
`MCP-Name: <nama tool>` (hanya `tools/call`, value di-encode:
ASCII polos apa adanya, bila tidak → `=?base64?<base64 UTF-8>?=`),
`MCP-Session-Id: <id>` (bila server pernah memberikannya lewat
header respons), `Authorization: Bearer <token>` (kecuali
`omitAuth: true`). Parameter tool yang skemanya beranotasi
`x-mcp-header` dicerminkan ke header `Mcp-Param-<nama>` dengan
encoding nilai yang sama. `tools/list` mengikuti `nextCursor`
(maks 10 halaman). `close()`: `DELETE` dengan `Mcp-Session-Id`
(hanya legacy).

**Parameter `initialize` (legacy) — persis:**

```json
{ "protocolVersion": "2025-11-25",
  "capabilities": {},
  "clientInfo": { "name": "makefun-github-core-clone-env", "version": "1.0.0" } }
```

id JSON-RPC `initialize-1`, **tanpa** header `MCP-Protocol-Version`.
Revisi dicoba berurutan newest-first:
`2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05`; server menjawab
dengan revisi yang dipilihnya (echo diterima sebagai revisi
negosiasi); bila server menjawab `-32602`, coba revisi berikutnya;
error lain → berhenti. Sukses → kirim notifikasi
`notifications/initialized` (tanpa id, tanpa header
`MCP-Protocol-Version`), lalu lanjut. `serverInfo` + `capabilities`
diambil dari `result`.

**Enam tool wajib** (nama kanonis github-mcp-server; server boleh
memakai prefix, mis. `github__create_issue` — dicocokkan sebagai
**suffix, case-insensitive**, setelah normalisasi "hapus semua
non-alfanumerik, lowercase"; alias juga diterima):

| Kanonis | Alias yang diterima |
|---|---|
| `create_repo` | `create_repository`, `repo_create`, `repos_create`, `repository_create` |
| `get_repo` | `get_repository`, `repo_get`, `repos_get`, `repository_get` |
| `create_issue` | `issue_create`, `issues_create` |
| `list_issues` | `issues_list`, `issue_list` |
| `create_pull_request` | `pull_request_create`, `pulls_create`, `create_pr`, `pr_create` |
| `merge_pull_request` | `pull_request_merge`, `pulls_merge`, `merge_pr`, `pr_merge` |

**Argumen yang dikirim suite** (bentuk semantik; suite memetakan ke
nama properti skema tool lewat sinonim, dan gagal dengan menyebut
properti bila ada `required` yang tak bisa diisi):

| Tool | Argumen semantik yang dikirim |
|---|---|
| `create_repo` | `{owner, name, description, private: true}` (owner ikut dikirim; `description` = deskripsi repo scenario pertama) |
| `get_repo` | `{owner, repo}` |
| `create_issue` | `{owner, repo, title, body}` |
| `list_issues` | `{owner, repo, state: "open"}` |
| `create_pull_request` | `{owner, repo, title, body, head, base}` |
| `merge_pull_request` | `{owner, repo, pull_number}` |

Sinonim pemetaan (dinormalisasi): owner →
`owner, owner_login, org, organization, organisation, user, user_login,
login, account, namespace, owner_name`; repo → `repo, repository,
repository_name, repo_name, repo_slug, project, project_name`;
`full_name`/`repo_full_name`/… menerima `"owner/repo"` bila properti
`repo` tak ada; title → `title, issue_title, pr_title,
pull_request_title, subject`; body → `body, issue_body, description,
content, text, comment`; head → `head, head_ref, head_branch,
pull_request_head, pr_head, source, source_ref, source_branch, from,
from_branch, branch`; base → `base, base_ref, base_branch,
pull_request_base, pr_base, target, target_ref, target_branch, into,
into_branch`; pull_number → `pull_number, pull_request_number,
pr_number, number, issue_number, index`; name → `name, repo,
repository, repository_name, repo_name`; description → `description,
about, summary, body`; private → `private, is_private`; state →
`state, status`.

**Setup REST yang dipakai cek MCP** (cek memakai REST apa adanya;
route REST yang rusak membuat cek MCP gagal dengan route + status):
`GET /api/v3/user` (login token; fallback login viewer scenario),
`POST /api/v3/user/repos`, `GET /api/v3/repos/{o}/{r}`,
`PUT /api/v3/repos/{o}/{r}/contents/{path}` (dengan/tanpa `branch`),
`POST /api/v3/repos/{o}/{r}/git/refs`,
`GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch}` (atau
`/branches/{branch}`), `GET/POST /issues`, `GET/POST /pulls`,
`GET /pulls/{n}`. Nama repo/branch/file memakai tag `6a09e667`
(lihat §0); PR setup: commit file di default branch, buat head
branch via `POST /git/refs` (fallback: `PUT /contents` dengan
`branch=<head>`), commit 1 file di head.

**Hasil tool** dibaca dari `content[].text` (blok `type: "text"`)
dan/atau `structuredContent`; JSON pertama yang ditemukan dipakai
untuk membaca `number`/`pull_number`. `isError: true` = tool gagal.

### 6.1 Daftar 15 cek mcp (urutan jalan)

| # | ID | Yang dikirim → harapan |
|---|---|---|
| 1 | `mcp.initialize` | `connect()` (discover dulu, fallback initialize). Harap: `serverInfo.name` dan `.version` string non-empty; `capabilities.tools` ada (record). Detail menyebut era + revisi. |
| 2 | `mcp.server-discover` | `connect()`; baca `discoverAttempt`. Era modern → `supportedVersions` non-empty (entri `YYYY-MM-DD`). Era pre-discover (404 / `-32601` / penolakan lain sebelum initialize berhasil) → **LOLOS** dengan detail `pre-discover revision (…)` — tidak pernah digagalkan karena tidak ada discover. |
| 3 | `mcp.tools-list` | `tools/list` `{}`. Harap: ≥ 6 tool; keenam tool wajib ada (nama kanonis/alias/prefix-suffix). |
| 4 | `mcp.tool-schemas` | `tools/list`. Harap: **setiap** tool punya `description` non-empty dan `inputSchema.type == "object"`. |
| 5 | `mcp.create-issue` | Setup repo REST `mcp-6a09e667-issue-create`; `tools/call create_issue {owner, repo, title: <issue[0].title>, body: <issue[0].body>}`. Harap: tanpa JSON-RPC error dan tanpa `isError`; REST `GET /issues?state=all&per_page=100` memuat issue dengan title sama. |
| 6 | `mcp.list-issues` | Setup repo; buat 1 issue via REST (`POST /issues`, catat number); `tools/call list_issues {owner, repo, state:"open"}`. Harap: teks hasil memuat title issue itu **atau** `"number": <n>` (regex `"number"\s*:\s*<n>`). |
| 7 | `mcp.create-pull-request` | Setup repo + head branch (REST, 1 commit); `tools/call create_pull_request {owner, repo, title, body, head, base}`. Harap: tanpa error; REST `GET /pulls/{n}` (number dari hasil tool, atau cari by title/head di `GET /pulls?state=all`) → `head.ref == head`, `base.ref == base`. |
| 8 | `mcp.merge-pull-request` | Setup repo + head branch + PR via REST; `tools/call merge_pull_request {owner, repo, pull_number}`. Harap: tanpa error; REST `GET /pulls/{n}` → `merged == true`. |
| 9 | `mcp.unknown-tool` | `tools/call` dengan `name: "mcp_no_such_tool_6a09e667"`, `arguments: {}`. Harap: JSON-RPC error `-32602` atau `-32601`; **tidak pernah HTTP 500**. |
| 10 | `mcp.parse-error` | `POST /mcp` body mentah (bukan JSON): `{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"` (tanpa kurung tutup). Harap: **HTTP 400 + JSON-RPC `-32700`**; untuk server legacy (pre-2026-07-28) **HTTP 200 + `-32700`** juga diterima. |
| 11 | `mcp.missing-arguments` | `tools/call create_issue` dengan `arguments: {}` (tanpa argumen wajib). Harap: `isError: true` **atau** JSON-RPC `-32602`. Bila tool tidak ditemukan → gagal; bila diterima tanpa error → gagal. |
| 12 | `mcp.concurrent-calls` | Dua repo setup (`mcp-6a09e667-concurrent-left/right`); dua `tools/call get_repo` **bersamaan** (`Promise.all`) dengan id `concurrent-left-6a09e667` dan `concurrent-right-6a09e667`. Harap: tiap jawaban membawa id-nya sendiri (`matchedId` cocok) dan teksnya menyebut repo-nya sendiri. |
| 13 | `mcp.tools-list-idempotent` | `tools/list` 2× berurutan. Harap: array tools **sama byte demi byte** (`JSON.stringify` kedua jawaban identik). |
| 14 | `mcp.rest-parity` | `tools/call create_repo {owner, name: "mcp-6a09e667-parity", description, private: true}` → baca `full_name` dari hasil (bila ada `owner/repo`, pakai itu); lalu `tools/call create_issue` di repo itu; `GET /repos/{o}/{r}` 2× → `id` sama; `GET /issues/{n}` 2× → `id` sama dan `title` sama. Harap: objek yang sama di MCP dan REST, id stabil antar baca. |
| 15 | `mcp.auth-required` | `tools/call create_issue {owner: "no-auth", repo: "no-auth-6a09e667", title, body}` dengan **`omitAuth: true`** (tanpa header Authorization). Harap: **HTTP 401** (nama tool diambil dari `tools/list` bila ada, else kanonis — auth diputus sebelum tool dikenali). |

---

## 7. Perf — 4 workload + T_ref (`bench.ts`, `manifest.ts`, `calibration.json`)

**Rumus poin per workload:** `points = round(clamp(25 − 12,5·log2(p50_ms / T_ref_ms), 0, 50))`.
Di T_ref = 25 poin; setengah T_ref = 38; seperempat (atau kurang) = 50;
dua kali T_ref = 13. **p50 = median 3 ronde** (nearest-rank);
p99 = ronde terbesar. Gagal/dipotong deadline → p50 = p99 = **1e9**,
0 poin (bukan 0 — 0 akan menang tie-break). `perf_p50_us` =
`round(1000 × geometric mean p50_ms workload yang terukur)`; bila
tidak ada yang terukur → 1e9. `points_total` = Σ 4 workload (0–200);
tiers = `floor(points / 12,5)` (0–4) per workload.

**T_ref (median 3 run house di production, 2026-11-14,
`calibration.json`):**

| Workload | T_ref (ms) | 3 run p50 (ms) | Poin di T_ref |
|---|---|---|---|
| push | **1640.82** | 1914.548, 1640.82, 1415.785 | 25 |
| clone | **266.941** | 266.941, 313.634, 259.436 | 25 |
| read | **2759.715** | 2874.092, 2759.715, 2428.118 | 25 |
| write | **348.965** | 448.01, 348.965, 289.433 | 25 |

Referensi di T_ref sendiri = 100/200. Spread antar-run
`perf_p50_us` 26,36% (712790–900674 µs) — variasi produksi, bukan
noise dalam-run. T_ref diukur di layout split (entry/env/forwarder
pod terpisah, gVisor, entry 2 CPU/1024 MiB, env 2 CPU/256 MiB);
produksi memakai layout `pod` (batas per-container sama).

**Cara ukur (umum):** jam monotonik `performance.now()`; tiap ronde =
wall time seluruh operasi ronde itu; semua payload dibangun **sebelum**
timing mulai; **5 operasi warm-up** tanpa timing sebelum ronde 1;
**3 ronde** per workload; setup (buat repo, history, issue) di dalam
budget workload tapi **di luar** ronde terukur; tiap workload budget
60 dtk; fase bench total 240 dtk; deadline internal trial
(start + 900 dtk − 90 dtk) memotong workload yang sedang jalan.

| Workload | Repo | Setup (di luar timing) | 1 ronde terukur | Warm-up |
|---|---|---|---|---|
| `push` | `bench-push` | Repo dibuat ulang (DELETE lalu create; DELETE 404 saat kosong diterima). **605 payload** dibangun di muka: tiap payload = 1 commit baru di `refs/heads/main` (blob 1024 byte baru + tree + commit; pack 3 objek, tanpa delta), rantai `oldOid` = commit sebelumnya (pertama `ZERO_OID`). | **200 push berurutan** (`git.push` + assert `unpack ok` + report ok; push ditolak = workload gagal). | 5 push |
| `clone` | `bench-clone` | Repo dibuat ulang; **1 push** berisi history **200 commit** (tiap commit ganti `history.txt` blob 512 byte; 600 objek dalam 1 pack). | **50 shallow clone `depth: 1` bersamaan** (`Promise.all`; `parse: false`, `singleBranch: true`); tiap clone harus: checksum pack terverifikasi, `packBytes > 0`, refs non-empty. | 5 clone |
| `read` | `bench-read` | Repo dibuat ulang; 1 issue dibuat via `POST /issues` (201, catat `number`). | **2000× `GET /api/v3/repos/{o}/{r}/issues/{n}` berurutan** pada **satu `RestClient` yang sama** (keep-alive, socket dipakai ulang); tiap respons harus 200 + body JSON object. | 5 GET |
| `write` | `bench-write` | Repo dibuat ulang; **605 judul** dibangun di muka (`"<title issue template> [bench <i>]"`). | **200× `POST /api/v3/repos/{o}/{r}/issues` berurutan**; tiap respons harus **201** (bukan 201 = workload gagal). | 5 POST |

**File yang dihasilkan:** `perf.json` (`version: 1`, `calibrated:
true` bila semua T_ref > 0, `workloads[]` berisi
`{name, rounds: [ms…], p50_ms, p99_ms, ops, points, error?}`,
`tiers`, `points`, `perf_p50_us`, `points_total`, `notes`).
`ops` per ronde: push 200, clone 50, read 2000, write 200.

## 8. Jawaban 7 pertanyaan (eksplisit)

### Q1 — Login GitHub apa yang dimiliki token `MAKEFUN_SHOP_TOKEN`? Repo dibuat atas nama owner apa?

**Owner = `adaiversen`.** Suite tidak pernah memanggil github.com
dan tidak pernah memvalidasi token ke pihak ketiga. Yang suite
lakukan: memakai `scenario.viewer.login` (= `adaiversen`, id 1000)
sebagai owner di **semua** pembuatan repo (git: `createRepo(owner =
adaiversen)`; REST: `POST /user/repos` lalu semua path
`/repos/adaiversen/…`; GraphQL fixture `owner: "adaiversen"`;
MCP `resolveOwner` = `GET /api/v3/user → login`, fallback viewer
scenario). Cek `graphql.viewer-login` menuntut
`viewer.login == "adaiversen"`, dan cek `repos.foreign-token`
menuntut nama repo yang sama di bawah `olgabauer` dijawab 404.
**Implikasi untuk forge: token apa pun yang disajikan sebagai
`Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` harus dipetakan ke
login `adaiversen`** (dan `GET /api/v3/user` harus menjawab
`{login: "adaiversen", …}`). Bila forge memetakan token ke login
lain, seluruh suite praktis gagal karena semua path owner-nya salah.

### Q2 — Format `X-GitHub-Request-Id`: bebas atau ada pola?

**Bebas — hanya wajib ada dan tidak kosong.** Satu-satunya assert di
seluruh kit adalah `expectHeader(response, 'x-github-request-id',
label, {nonEmpty: true})` (`checks-rest.ts protocolRequestId`, 4
panggilan) dan pernyataan RULES.txt: "carries a non-empty
X-GitHub-Request-Id header". Tidak ada regex, pola UUID, panjang,
atau nilai yang diperiksa di `rest-client.ts`, `checks-rest.ts`,
`RULES.txt`, maupun `competition.yaml`. Nilai apa pun yang non-empty
(mis. UUID, counter, string tetap) lolos.

### Q3 — Page size paginasi `GET /user/repos` dan format Link header

- **Page size yang diminta suite: `per_page=10`** (cek
  `repos.pagination`: URL awal
  `GET /api/v3/user/repos?per_page=10`). Server harus menjawab
  **≤ 10 item per halaman** (lebih dari 10 = gagal).
- **Format Link header: `Link: <url>; rel="next"`** (satu URL absolut
  per relasi, dipisah koma bila ada beberapa). Parser suite
  (`parseLinkHeader`): memecah pada koma, regex
  `/<([^>]*)>\s*;\s*rel\s*=\s*"?([A-Za-z]+)"?/`; relasi yang dikenali:
  `next`, `prev`, `first`, `last`.
- **Hanya `rel="next"` yang diikuti** — `first`/`last`/`prev` tidak
  wajib ada dan tidak dibaca. URL `next` harus **satu origin** dengan
  base URL (kalau tidak → gagal). Suite mengikuti rantai sampai `next`
  hilang, maks **20 halaman**; menuntut ≥ 3 halaman untuk 30 repo,
  tanpa nama yang berulang, dan semua 30 nama muncul.
- `per_page=100` dipakai di daftar issue/PR (`list-open`, dsb.) tapi
  **tidak** ada assert paginasi di sana (cek hanya membaca halaman
  pertama).

### Q4 — Apa yang dilakukan git-client suite saat fetch? Apakah mengirim haves? deepen? Mengharapkan thin-pack?

**Ya untuk ketiganya, dengan detail berikut (`git-client.ts`
`fetch`/`fetchV2`/`fetchV0`):**

- **Haves: YA, selalu dikirim bila ada.** `fetchV2` mengirim baris
  `have <oid>` untuk tiap `request.haves` (setelah baris `want`,
  sebelum `done`). `fetchV0` mengirimnya di seksi kedua (setelah
  `flush` pertama, sebelum `done`). Cek yang mengirim haves:
  `fetch-incremental` (`haves: [tip lama]`), `fetch-nothing-new`
  (`haves: [tip]`), `fetch-shallow-deepen` dan
  `fetch-shallow-new-tip` (`haves: [tip]` + `shallow: […]`).
  **Server wajib menghormati haves**: `fetch-incremental` gagal bila
  server mengirim ulang objek yang sudah dimiliki client, dan
  `fetch-nothing-new` gagal bila ada objek apa pun yang terkirim.
  Server yang selalu menjawab NAK / mengabaikan `have` **tidak lolos**
  (catatan: draf PLAN.md lama yang menulis "haves selalu dijawab NAK"
  bertentangan dengan suite — yang benar: ACK have yang dimiliki dan
  kirim hanya objek baru).
- **Deepen: YA, bila `depth != null`.** Baris `deepen <N>` dikirim di
  v2 maupun v0. `clone {depth: 1}` → `deepen 1`; `fetch-shallow-deepen`
  → `deepen 2` (plus `shallow <tip lama>`); `fetch-shallow-new-tip` →
  `deepen 1`. Server yang tidak mengiklankan `shallow` pada
  capability `fetch` (v2) / advertisement (v0) membuat client throw
  sebelum request dikirim (cek gagal).
- **Thin-pack: YA, diminta dan diharapkan bisa diterima.**
  v2: baris `thin-pack` dikirim **default** (hanya hilang bila
  `thinPack: false` — tidak ada cek yang mematikannya). v0:
  `thin-pack` ditambahkan ke capability baris `want` pertama **hanya
  bila server mengiklankannya**. Sisi client: `readPack` me-resolve
  delta OFS/REF, dan basis delta yang tidak ada di dalam pack diambil
  dari `request.haveObjects` (objek yang sudah dimiliki client) —
  itulah thin-pack. Server **boleh** menjawab dengan pack penuh
  (bukan thin) — tidak ada cek yang mewajibkan server mengirim delta
  (`pack-deltas` hanya menuntut kebenaran bila delta dikirim).
- Selain itu v2 selalu mengirim (default): `thin-pack`, `no-progress`,
  `ofs-delta`, `agent=makefun-git-client/1.0` (bila caps `agent`),
  `object-format=sha1` (bila caps `object-format`), dan `done` di
  akhir. v0 mengirim capability pada baris `want` pertama:
  `side-band-64k` (wajib — bila tidak diiklankan client throw),
  `multi_ack_detailed`/`multi_ack`, `thin-pack` (bila diiklankan),
  `no-progress`, `ofs-delta`; lalu `flush`, `have…`, `done`, `flush`.
- Respons fetch yang diharapkan: seksi `acknowledgments`
  (`NAK`/`ACK`/`ready`), `shallow-info`, `packfile` (sideband band 1
  = data, band 2 = progress, band 3 = error) — dan pack harus lolos
  checksum trailer SHA-1.

### Q5 — Dokumen GraphQL persis yang dikirim gh dan github-mcp-server

**Disalin lengkap di §5.1** (18 dokumen: `ViewerLogin`,
`RepositoryFields`, `Issue_fields`,
`PullRequestAndRepositoryFields`, `SearchType_enumValues`,
`OpenIssues`, `IssueByNumber`, `IssueCreate`, `IssueClose`,
`PullRequests`, `PullRequestFiles`, `PullRequestId`,
`PullRequestCreate`, `MergePullRequest`, `AddComment`,
`ViewerInvalidField`, `NodeRepository`, `IssuesPage`) **beserta
variabel tiap cek di §5.2**. Catatan penting: kit menyatakan
dokumen-dokumen itu adalah dokumen yang **gh** kirim, dan
github-mcp-server memakai "the same githubv4 shapes" — **tidak ada
dokumen terpisah untuk github-mcp-server di dalam kit**; satu set
dokumen yang sama itulah yang suite kirim untuk mewakili keduanya.
Variabel kuncinya: `createIssue {input: {repositoryId, title, body}}`,
`closeIssue {input: {issueId}}`,
`createPullRequest {input: {repositoryId, baseRefName, headRefName, title}}`,
`mergePullRequest {input: {pullRequestId, mergeMethod: "SQUASH"}}`,
`addComment {input: {subjectId, body}}`; query memakai variabel
`$owner/$name/$first/$number/$after` (lihat §5.2 per cek).

### Q6 — Parameter initialize MCP dan bentuk argumen tiap tools/call

**Initialize (legacy; modern tidak ada initialize — pakai
`server/discover`):** lihat §6. JSON-RPC `initialize`, id
`initialize-1`, **tanpa** header `MCP-Protocol-Version`, params
persis:

```json
{ "protocolVersion": "2025-11-25",
  "capabilities": {},
  "clientInfo": { "name": "makefun-github-core-clone-env", "version": "1.0.0" } }
```

Revisi dicoba `2025-11-25 → 2025-06-18 → 2025-03-26 → 2024-11-05`
(berhenti di yang pertama sukses; `-32602` → coba berikutnya).
Sukses → notifikasi `notifications/initialized` `{}` (tanpa id).
**Modern (2026-07-28):** `server/discover` `{}` + `_meta`
(`io.modelcontextprotocol/protocolVersion`,
`io.modelcontextprotocol/clientInfo`,
`io.modelcontextprotocol/clientCapabilities: {}`,
`protocolVersion`) dan header `MCP-Protocol-Version: 2026-07-28`.

**Bentuk `tools/call`:** JSON-RPC params `{name: "<nama tool
(resolved, mis. github__create_issue)>", arguments: {…}}`, header
`MCP-Method: tools/call` + `MCP-Name: <nama tool>`. Argumen per tool
(semantik; dipetakan ke properti skema — sinonim lengkap di §6):

| Tool | `arguments` yang dikirim |
|---|---|
| `create_repo` | `{owner, name, description, private: true}` |
| `get_repo` | `{owner, repo}` |
| `create_issue` | `{owner, repo, title, body}` |
| `list_issues` | `{owner, repo, state: "open"}` |
| `create_pull_request` | `{owner, repo, title, body, head, base}` |
| `merge_pull_request` | `{owner, repo, pull_number}` |

`tools/list`: params `{}` (atau `{cursor}` untuk halaman berikut).
Jawaban tool dibaca dari `result.content[].text` dan/atau
`result.structuredContent`; `result.isError: true` = tool gagal.

### Q7 — Urutan suite

Lihat **§2** (lengkap): boot (register → `GET /healthz` 2×) →
instal git fixture GraphQL → conformance berurutan
**git 30 → repos 15 → issues 15 → pulls 20 → protocol 5 →
graphql 20 → mcp 15** (di dalam REST, `repos.pagination` pertama) →
benchmark **push → clone → read → write** → export
(`state.json` lalu `perf.json`) → `GET /done` menjawab
`{"done": true}`. Budget: boot 20 dtk, conformance 240 dtk,
benchmark 240 dtk, export 30 dtk; deadline internal = start +
900 dtk − 90 dtk. Cek yang kehabisan waktu dicatat 0 `deadline`
dan suite lanjut ke cek berikut.

---

## 9. TIDAK PASTI (tidak bisa dipastikan dari source)

1. **Pemetaan token → login di sisi platform.** Kit tidak memuat
   dokumen apa pun yang menyatakan token `MAKEFUN_SHOP_TOKEN` yang
   dicetak platform pada trial nyata dipetakan ke login apa di sisi
   platform. Suite hanya membuktikan forge **harus menjawab**
   `adaiversen` (Q1). Bila platform mencetak token untuk login lain,
   suite tetap menuntut `adaiversen` — forge harus memetakan token
   shop apa pun ke `adaiversen`, bukan menebak dari token.
2. **Dokumen GraphQL khusus github-mcp-server.** Kit tidak memuat
   dokumen terpisah untuk github-mcp-server; header
   `checks-graphql.ts` menyatakan github-mcp-server memakai "the same
   githubv4 shapes" dengan gh. Jadi Q5 dijawab dengan satu set dokumen
   gh (§5.1) — bila github-mcp-server asli mengirim dokumen yang
   berbeda di lapangan, kit tidak menunjukkannya.
3. **Apakah server wajib membaca `_meta` MCP.** Client mengirim
   `_meta` (termasuk `protocolVersion`) di tiap request dan header
   `MCP-Protocol-Version`, tetapi **tidak ada cek** yang memverifikasi
   server membaca/menggunakan `_meta`. Server yang mengabaikan `_meta`
   sepenuhnya tidak terbukti gagal oleh suite.
4. **Nilai `X-OAuth-Scopes`.** Hanya keberadaan header yang dicek
   (`repos.root`); isi nilainya (mis. `repo, user`) tidak diperiksa
   di mana pun.
5. **Bentuk `GET /api/v3/user` di luar `login`.** MCP hanya membaca
   field `login` (fallback ke viewer scenario bila route menolak);
   field lain (`id`, `name`, …) tidak diasertikan oleh cek mana pun.
6. **Jalannya `grade-local --driver process` end-to-end.**
   Didokumentasikan dari teks `cli/makefun.mjs --help` saja; tidak
   dieksekusi di VM ini (butuh entry + trial run). Rute A (`sdk/run.ts`)
   dan start `server.mjs` sudah diverifikasi langsung (lihat §1).
7. **Angka perf di mesin lain.** T_ref adalah median 3 run di
   production (dsh-makefun, gVisor, layout split); waktu yang diukur
   lokal akan berbeda. Poin dihitung dari rasio terhadap T_ref, jadi
   perbandingan lokal tetap bermakna, tetapi skor perf lokal bukan
   skor final.
8. **Perilaku server atas `filter` fetch dan `deepen-since` /
   `deepen-not`.** Client mendukung pengiriman ketiganya, tetapi
   **tidak ada cek** yang mengirim `filter`, `deepen-since`, atau
   `deepen-not` — dukungannya tidak dinilai.
9. **Isi `capabilities` advertisement v2 di luar yang dicek.**
   `advertise-v2` hanya mewajibkan `fetch` + `ls-refs` (+
   `object-format: sha1` bila ada). Capability lain (`agent`,
   `ls-refs=unborn`, `fetch=shallow`, `fetch=filter`, `object-format`)
   bersifat opsional kecuali bila suatu cek membutuhkannya
   (`ls-refs` memakai `unborn` hanya bila diiklankan; fetch shallow
   mewajibkan `fetch=shallow`).

---

## 10. Peta file sumber (untuk verifikasi ulang)

| Topik | File kit |
|---|---|
| Aturan + endpoint contract | `RULES.txt` (± baris 17–57), `competition.yaml` |
| Daftar grup + skor + T_ref + workload | `program/env/src/manifest.ts`, `program/env/src/calibration.json` |
| Cek git | `program/env/src/checks-git.ts` (30 `define(...)`, baris ±1–1150) |
| Cek REST + protocol | `program/env/src/checks-rest.ts` |
| Cek GraphQL + 18 dokumen | `program/env/src/checks-graphql.ts` |
| Cek MCP | `program/env/src/checks-mcp.ts` |
| Bench | `program/env/src/bench.ts` |
| Wire (env var, register/done, scenario seed) | `program/env/src/wire.ts` |
| Client git (fetch/push/clone/ls-refs) | `program/env/src/git-client.ts` |
| Client REST / GraphQL / MCP | `program/env/src/rest-client.ts`, `graphql-client.ts`, `mcp-client.ts` |
| Urutan + lifecycle + export | `program/env/src/main.ts`, `program/env/src/export.ts` |
| Skoring | `program/scorer/{score,columns,main}.ts` |
| Env bundle (jalan langsung dengan node) | `program/env/server.mjs` |
| Runner lokal | `sdk/run.ts` (salinan suite di `sdk/conformance/`) |
| CLI grade-local | `cli/makefun.mjs` (`grade-local --help`) |
| Instance/drw | `rules/instance.yaml` (praktik 3 trial; final 3 instance, drand quicknet round 34146612, 2026-11-21T06:40:00Z) |

*Dokumen ini hanya inventaris — tidak mengubah kode, tidak commit,
tidak submit apa pun.*
