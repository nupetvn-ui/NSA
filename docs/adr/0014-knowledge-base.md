# ADR-0014: Knowledge Base — dạy NSA bằng tài liệu, ảnh, video; hộp duyệt riêng; tìm theo nghĩa; tool cho agent

- Trạng thái: Chấp nhận
- Ngày: 2026-11-13
- Bổ sung cho [ADR-0008](0008-nsa-mem.md) (NSA Mem), [ADR-0009](0009-nguon-model-qua-api-key.md) (model theo việc), [ADR-0010](0010-app-store-plugin-host-va-cong-mcp.md) (plugin host), [ADR-0012](0012-quyen-cli-va-plugin-google-workspace.md) (quyền `cli`)

## Bối cảnh

Giai đoạn 5 của [PLAN.md](../PLAN.md): người dùng dạy NSA bằng file, ảnh, video, âm thanh và đường link, rồi duyệt điều nó học được; agent hỏi lại và trả lời **kèm nguồn** (trang, mục, khung hình, phút-giây). Tiêu chí: "Dạy bằng 1 video, hỏi lại trả lời đúng". Làm đúng khuôn plugin hiện có, dùng lại hộp duyệt + quy tắc tự duyệt của NSA Mem và chọn model theo việc — không dựng đường riêng.

## Quyết định

### Một plugin, mã nguồn + một file đóng gói

`plugins/knowledge-base` (`nsa-plugin.json`, `src/*.js`, `ui/`, `main.js`). Plugin không có `node_modules` lúc chạy (ADR-0010), nên `build.mjs` (esbuild) gộp `src/` thành **một file `main.js` (~2,4 MB, được commit)**; test `plugins/knowledge-base-host.test.ts` tự build lại trước khi chạy để không lệch. Nạp tài liệu chạy **cục bộ, trong tiến trình plugin** — nội dung tài liệu không gửi đi đâu để tách chữ.

### Tách tài liệu (thuần JavaScript, không nhị phân gốc)

| Định dạng              | Cách làm                                                                                             | Vì sao                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| PDF                    | `unpdf` (MIT; đóng gói sẵn pdf.js của Mozilla, Apache-2.0, không cần worker) → mỗi trang một khối    | gộp được bằng esbuild, chạy được dưới `node --permission`; đã thử trong bản đóng gói                           |
| DOCX, XLSX             | **tự tách** bằng `fflate` (MIT, ~30 KB): đọc `word/document.xml` / `xl/*`, giữ tiêu đề mục và ô tính | `mammoth` / `SheetJS` / `exceljs` kéo thêm hàng MB và phụ thuộc; SheetJS trên npm là bản cũ có lỗ hổng đã biết |
| HTML, link trang web   | bộ tách riêng (bỏ script/style/nav, giữ heading); link tải qua `ctx.fetch`                           | không cần DOM; link đi qua cổng mạng của plugin host                                                           |
| Văn bản, Markdown, CSV | tự đọc (Markdown theo heading, CSV có ngoặc kép → "tên cột: giá trị")                                | đơn giản, kiểm được                                                                                            |

Mỗi khối có **vị trí gốc** (`trang 3`, `mục: A › B`, `Giá!A2:F13`, `dòng 10–25`, `00:05–00:50`) ghi vào thẻ `kb:loc:` và vào cuối nội dung ("— Nguồn: tên · vị trí"). **Chưa có OCR**: PDF quét (không có chữ) được cảnh báo rõ, hướng dẫn xuất trang thành ảnh để model nhìn ảnh đọc.

### Ảnh

Model loại việc **"nhìn ảnh"** của `packages/providers` mô tả và chép nguyên văn chữ trong ảnh; lời dặn của người dùng ("đây là bảng giá tháng 11") đi kèm trong lời nhắc **và** được lưu cùng mục nhớ; file gốc giữ ở thư mục dữ liệu của plugin (`files/<mã>/original.*`). Giới hạn 10 MB/ảnh (chưa có bước thu nhỏ ảnh).

### Video và âm thanh: ffmpeg + whisper.cpp qua quyền `cli`

Pipeline (mỗi bước lưu vào `derived.json` nên **chạy tiếp được sau khi đóng app**): `ffprobe` (thời lượng) → `ffmpeg` tách tiếng 16 kHz mono → `whisper-cli` nhận dạng giọng nói thành phụ đề có mốc thời gian → `ffmpeg` tách khung hình theo đổi cảnh (`select=gt(scene,0.3)`) + bổ sung khung cách đều cho video dài ít đổi cảnh, tối đa 40 khung → model nhìn ảnh mô tả từng khung → gộp phụ đề + mô tả theo cửa sổ ~45 giây (cắt ở khung đổi cảnh) thành mục nhớ dẫn về đúng `mm:ss–mm:ss`. Thiếu một vế (chưa có whisper, hoặc chưa có model nhìn ảnh) thì vẫn nạp bằng vế còn lại **và ghi cảnh báo**; thiếu cả hai thì báo lỗi rõ, không nạp nửa vời. Chạy chương trình ngoài **chỉ qua quyền `cli` của lõi** — plugin không tự sinh tiến trình.

**So sánh phương án (đã chọn cột đậm):**

|                         | Đóng gói kèm                                                                                                                                                                                                                                                                                                     | Tải khi dùng lần đầu                                                                                                                                                                                        | Gọi API / chương trình có sẵn                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ffmpeg**              | bản Windows "full" của Gyan 9.0.2 trên máy này: `ffmpeg.exe` **~228 MB** (+ `ffprobe` ~228 MB, cả thư mục 665 MB), build `--enable-gpl --enable-version3` → **GPLv3**; bản LGPL cũng vài chục MB nhưng ta không kiểm soát được cấu hình. Đóng kèm vào app thương mại kéo theo nghĩa vụ GPL và +100–230 MB bộ cài | plugin tải rồi chạy một `.exe` do chính nó tải = **tự cấp quyền chạy mã** ngoài khuôn `cli` (lõi chỉ chạy lệnh theo tên trong PATH) — cần cơ chế "thư mục chương trình tin cậy" của lõi, chưa có            | **Chọn: chương trình có sẵn trong PATH** (`winget install Gyan.FFmpeg`, người dùng tự cài; NSA không cài hộ). Plugin tự phát hiện và hiện hướng dẫn nếu thiếu                                                                                                                                                           |
| **Nhận dạng giọng nói** | whisper.cpp (**MIT**) `whisper-cli.exe` + DLL vài MB; model ggml: tiny **~78 MB**, base **~148 MB**, small **~488 MB** (Whisper là MIT). Model không nên nằm trong bộ cài                                                                                                                                        | **Chọn cho model**: màn hình Công cụ có nút "Tải model" (huggingface.co/ggerganov/whisper.cpp, từng khúc 8 MB vì mỗi lệnh gọi mạng bị giới hạn 10 MB), người dùng bấm mới tải, lưu ở thư mục dữ liệu plugin | **Chọn cho chương trình**: `whisper-cli` tự cài vào PATH (GitHub Releases của ggml-org/whisper.cpp). API (OpenAI / Groq `audio/transcriptions`) không chọn vì (1) gửi nguyên âm thanh đi, (2) providers chưa có loại việc "giọng nói", plugin lại không được đọc key → bắt người dùng dán key hai nơi; để giai đoạn sau |

Lý do chung: **không đóng nhị phân lớn/GPL, không để plugin tự tải mã chạy được, mọi thứ chạy ngoài khuôn quyền `cli`**; người dùng thấy rõ cái gì cần cài và chọn cài.

**Siết quyền `cli`** (cần vì ffmpeg ghi file theo đường dẫn tuỳ ý): manifest mới `"confinePaths": true` — mọi tham số có dạng **đường dẫn tuyệt đối** (kể cả sau `--cờ=`) phải nằm trong thư mục dữ liệu của plugin hoặc thư mục người dùng đã cấp; chứa `..` hoặc là địa chỉ mạng (`rtmp://`, `http://`) thì bị từ chối trước khi chạy. Lệnh con khai theo tiền tố (`-hide_banner`, `-v`, `-m`); thời hạn lệnh tối đa 15 phút (thay vì 2 phút) vì việc nặng. Giới hạn còn lại: tham số **tương đối** không bị kiểm (nhưng cwd là thư mục tạm của hệ điều hành); ffmpeg vẫn là chương trình mạnh — chặn ở mức "không ra ngoài thư mục dữ liệu, không ra mạng", không phải sandbox.

### Việc nặng chạy nền

Danh mục nguồn `catalog.json` + hàng đợi nằm trong thư mục dữ liệu của plugin. Mỗi nguồn: `estimating → awaiting → queued → running → ingested` (hoặc `paused / failed / cancelled`); tiến trình hiện thanh + nhãn; **tạm dừng / tiếp tục / huỷ** từng nguồn và cả hàng đợi. Đóng app giữa chừng: trạng thái `running` trên đĩa được xếp lại khi plugin bật (`activate` + việc nền 15 giây) và **chạy tiếp từ bước cuối đã lưu** (đã đo: kill app khi mới mô tả 2/3 khung hình → mở lại chỉ gọi model 1 lần cho khung còn thiếu).

**Ước tính trước khi chạy**: số lượt gọi model nhìn ảnh, token (≈1500 vào + 250–500 ra mỗi ảnh / khung), chi phí theo giá của model đầu chuỗi (`ctx.model.status('vision')`). Hỏi người dùng khi ước tính ≥ ngưỡng (mặc định 0,02 USD) **hoặc chưa biết giá**; tài liệu văn bản không gọi model nên không hỏi. Tôn trọng **hạn mức tháng** của `packages/providers`: trạng thái `over` thì dừng bằng lời nhắn rõ; nếu người dùng bật "dừng khi vượt" thì chính sách `model.use` cũng chặn.

### Mọi thứ học được vào hộp duyệt

Plugin chỉ **đề xuất** (`memory.propose`); không có đường ghi thẳng. Nhánh `plugin/knowledge-base/kien-thuc/<bộ-sưu-tập>` (ẩn) được tạo với **tự nhận TẮT** (mọi thứ chờ người duyệt); người dùng có thể bật "tự nhận khi đủ tin cậy" trong Cài đặt — khi đó chạy đúng quy tắc tự duyệt của NSA Mem (ngưỡng tin cậy, không mâu thuẫn). Độ tin cậy: tài liệu 0,9; link 0,85; ảnh 0,8; video 0,75.

- **Nhạy cảm** (số thẻ qua kiểm Luhn, CCCD, mật khẩu, khoá API / token, khoá riêng, số tài khoản): đề xuất đánh `sensitive` + độ tin cậy ≤ 0,5 → **không bao giờ tự nhận** (và `judgeProposal` của NSA Mem còn tự bắt thêm số điện thoại…), nguồn hiện cảnh báo; thẻ đỏ trong hộp duyệt; "Nhận cả lô" bỏ qua mục nhạy cảm trừ khi người dùng xác nhận; nút **Che số nhạy cảm** (giữ 4 ký tự cuối) rồi nhận. Mục nhạy cảm không vào chỉ mục vector, không hiện cho agent qua `kb_search`/`kb_open`.
- **Nạp lại file đã đổi không nhân đôi**: nguồn xác định theo `(loại, đường dẫn tương đối hoặc tên)`; cùng nội dung → bỏ qua; khác → mục cùng `kb:loc` được **sửa tại chỗ** (`targetId`, hiện bản cũ để đối chiếu), đoạn mới thì thêm, đoạn không còn thì **gỡ** (hoàn tác được bằng "Hoàn tác gỡ"). Đề xuất cũ chưa duyệt của chính nguồn đó bị bỏ.
- **Xoá nguồn** gỡ luôn các mục nhớ sinh ra từ nó (xoá = commit git của NSA Mem) và đề xuất đang chờ; file gốc chuyển vào "thùng" (giữ 5 lần gần nhất); **Hoàn tác** khôi phục cả mục nhớ lẫn nguồn.
- Liên kết mục nhớ ↔ nguồn nằm trong **thẻ** (`kb:src:<mã>`, `kb:loc:<vị trí>`, `kb:h:<hash>`, `kb:kind:<loại>`), nên vẫn đúng sau khi dựng lại chỉ mục từ Markdown.

### Tìm theo nghĩa (vector) — có, sau interface `VectorIndex` của ADR-0008

`EmbeddingVectorIndex` (`packages/memory/src/embedding-index.ts`) hiện thực `VectorIndex` bằng model loại việc **"embedding"**: không nhị phân gốc, không model đóng kèm — dùng hãng người dùng đã có key (OpenAI-chuẩn `/embeddings`: Google AI Studio, OpenAI, Qwen…) hoặc Ollama / LM Studio (`nomic-embed-text`…). Vector lưu ở `.nsa/vectors.json` (không vào git), **dựng lại được từ Markdown** khi mất file hoặc đổi model (số chiều khác). Tính vector **lười**: ghi mục nhớ không gọi mạng, lần tìm đầu mới bổ sung vector còn thiếu theo lô; mục nhạy cảm không bao giờ được gửi đi. `MemoryService.searchHybrid` trộn FTS5 + vector theo hạng (RRF); **chưa có model embedding, hoặc lỗi mạng / hết hạn mức → lùi về FTS5** và báo `mode: keyword` (agent và màn hình đều thấy "tìm theo từ khoá"). Lần này **chỉ plugin dùng `searchHybrid`**; `mem_search` và phần ngữ cảnh tự chèn của NSA Mem vẫn là FTS5 (đổi sang lai là việc nhỏ ở sau, nhưng làm đổi hành vi mọi agent nên không gộp vào đây). `sqlite-vec` và model cục bộ đóng gói kèm **không làm**: vẫn là nhị phân gốc / vài chục MB cần thử riêng, và với kho cỡ cá nhân (≤ vài nghìn mục) so cosine trong bộ nhớ là đủ nhanh.

### Tool cho agent (cổng MCP, qua `Policy` + `AuditLog`)

`kb_search` (tìm lai; trả mã mục + trích đoạn + **NGUỒN**), `kb_open` (nội dung đủ + đoạn gốc xung quanh / phụ đề quanh mốc thời gian + **đường dẫn file gốc và khung hình** để agent xem ảnh), `kb_sources`. Cả ba `readOnly`. Mục chưa duyệt và mục nhạy cảm không bao giờ lộ ra.

### Giao diện

Màn hình trong App Store: khu thả file/thư mục (kéo-thả hoặc chọn; tải lên từng đoạn 384 KB qua `window.nsa` vì khung plugin cô lập không có API file), dán link, quét thư mục đã cấp quyền (video dùng tại chỗ, không chép); danh sách nguồn + trạng thái + thanh tiến trình + nút tạm dừng/tiếp tục/huỷ/xoá; thanh ước tính chi phí chờ đồng ý; tab **Duyệt** riêng (đối chiếu đoạn gốc / khung hình / phụ đề cạnh mục đề xuất, nhận / sửa rồi nhận / từ chối / nhận cả lô, lọc theo nguồn); tab Tìm thử; tab Công cụ & cài đặt (tình trạng ffmpeg, whisper, model nhìn ảnh, embedding; tải model giọng nói). Khung plugin chạy `sandbox="allow-scripts"` nên **`confirm()` bị chặn** — xác nhận làm ngay trong trang (lỗi này lộ ra khi chạy app thật).

### Thay đổi ở lõi (nhỏ, tổng quát, có test)

- `permissions.modelTasks` (`channel` mặc định, `background`, `vision`, `embedding`): người dùng thấy rõ trong hộp xin quyền plugin được nhờ việc gì; `ctx.model.vision / embed / status` (host nối `ModelTaskRunner` + `ProviderHub`; ảnh đi qua `RunOptions.images` → adapter `api`).
- `ctx.memory`: `searchSemantic`, `entries` (kèm thẻ), `pending`, `accept` (có sửa), `reject`, `remove` / `restore` (hoàn tác chỉ khi commit chỉ chạm file trong nhánh của chính plugin), `setAutoApprove`; `propose` nhận `sensitive`, `tags`, `targetId`. Mọi thao tác **khoá trong nhánh của plugin**.
- `permissions.network: ["*"]` = mọi trang web **công cộng** (vẫn kiểm từng bước chuyển hướng); **không bao giờ** gồm localhost, tên một nhãn, `.local`/`.internal`, địa chỉ IP thuần. Hộp xin quyền ghi to "MỌI trang web". Còn thiếu: tên miền công cộng trỏ DNS về IP nội bộ (DNS rebinding) chưa bị chặn.
- `permissions.cli[].confinePaths` (ở trên).
- Model tự khai báo / Ollama: `guessLocalModel` đoán theo tên (`llava`, `*vision*`, `*-vl`, `pixtral`… → nhìn được ảnh; `*embed*` → embedding) để model cục bộ vào được chuỗi "nhìn ảnh" / "embedding"; đoán sai thì chỉnh ở Nhà cung cấp.
- Ngữ cảnh tự chèn đầu lượt **bỏ qua nhánh ẩn** (của plugin): chạy thật cho thấy cả kho Knowledge Base bị nhồi vào mọi cuộc trò chuyện (kho ≤ 60 mục thì chèn hết); giờ agent tra qua `kb_search`.

## Kết quả chạy thật (2026-11-13, Windows 10)

Máy: `ffmpeg`/`ffprobe` 9.0.2 (winget, có sẵn trong PATH), Claude Code 2.1.322 và OpenCode 1.19.5 thật; **không có** Ollama / LM Studio, không có key model nhìn ảnh, **không có `whisper-cli`**.

- **Dev và bản đóng gói** (`NSA.exe`, `win-unpacked`): cài plugin từ thư mục, kéo file vào màn hình (đi qua đúng đường tải lên từng đoạn), nạp PDF + ảnh (kèm lời dặn) + video 15 giây (ffmpeg / ffprobe thật tìm thấy trong PATH của bản đóng gói; `unpdf` trong `main.js` chạy dưới `node --permission`), duyệt trong tab Duyệt, rồi **hỏi Claude Code**: đổi trả → "7 ngày — `chinh-sach.pdf`, trang 1"; video → "bước 2 ở mốc 00:05, `huong-dan.mp4`, đoạn 00:00–00:15" (Claude Code còn tự `kb_open` rồi mở khung hình gốc để kiểm). **OpenCode** trả lời đúng giá trà đào từ ảnh, nêu `bang-gia.png`. Bản đóng gói: PDF + ảnh + video → duyệt → Claude Code trả lời đúng mốc 00:10.
- **Đóng app giữa chừng một lô**: giết `NSA.exe` khi video mới mô tả 2/3 khung → mở lại, tự chạy tiếp, chỉ 1 lần gọi model cho khung còn thiếu.
- **Số thẻ giả** trong `.txt`: không vào kho (0 file Markdown chứa số thẻ), thẻ đỏ + cảnh báo; Claude Code hỏi "thẻ số mấy" → "Knowledge Base không có". Sau "Che số nhạy cảm → Nhận" kho chỉ chứa `●●●●1111`.
- **Xoá nguồn** gỡ mục nhớ khỏi kho (đếm "đã nhớ" giảm) và **Hoàn tác** trả lại, bằng nút trong giao diện.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` đều qua.

### Chưa chạy thật — nói thẳng

- **Model nhìn ảnh và embedding là máy chủ GIẢ** (`fake-openai`, chuẩn OpenAI, khai làm nhà cung cấp tự khai báo): nó trả mô tả **có sẵn** (không thật sự nhìn ảnh; mô tả khung hình theo mốc thời gian đã soạn trước cho đúng video thử), embedding là túi từ băm. Đường ống, ước tính chi phí, hạn mức, ghi nhận token đều thật; **chất lượng mô tả ảnh / video và độ chính xác tìm theo nghĩa với model thật chưa kiểm**. Người dùng mới có key DeepSeek (không nhìn ảnh): cần tự dán key của hãng nhìn được ảnh (ví dụ Google AI Studio) ở màn hình Nhà cung cấp.
- **Nhận dạng giọng nói: chỉ mới thử thật với TIẾNG ANH, model `tiny`.** Sau khi người dùng đồng ý, đã tải `whisper-bin-x64.zip` (whisper.cpp v1.9.2, 8,2 MB, từ GitHub Releases của ggml-org) vào thư mục tạm và thêm vào PATH của lần chạy thử (không cài vào hệ thống), và bấm nút "Tải model tiny" trong app: tải thật từ huggingface từng khúc 8 MB, **77.691.713 byte, trùng từng byte** với bản tải thẳng. Video thử có giọng đọc tiếng Anh tổng hợp bằng Windows SAPI (máy không có giọng tiếng Việt): `whisper-cli` thật chạy qua quyền `cli`, mục nhớ có "Lời nói: Step 1. Log into the sales software…" cạnh mô tả khung hình, và Claude Code trả lời đúng câu hỏi về lời nói. **Tiếng Việt chưa kiểm** (không có giọng thử, model `tiny` / `base` thường kém với tiếng Việt, tên riêng và con số hay sai): lời nói được gắn nhãn "phụ đề tự động, có thể sai" và mỗi dòng phụ đề có mốc `[mm:ss]` riêng. Chưa lọc "ảo giác" của whisper (câu lặp / câu chèn khi im lặng), chưa hạ độ tin cậy theo chất lượng.
- Link trang web (`addUrl`) có test với `fetch` giả (trang HTML có tiêu đề / mục, nạp lại không đổi, link sai / HTTP 404 / loại lạ) nhưng **chưa thử với trang web thật trong app**.
- Chưa thử video dài / lô lớn (hàng trăm file), ảnh lớn hơn 10 MB (bị từ chối, chưa có thu nhỏ).

## Bộ kiểm chất lượng nhớ lại (`plugins/knowledge-base-quality.test.ts`)

Cố định, chạy lặp lại được trong `pnpm test` (in bảng số liệu; chạy hai lần phải ra kết quả y hệt). Kho thử: 6 tài liệu tiếng Việt có dấu (Markdown, XLSX, DOCX, HTML, TXT, PDF chỉ ASCII), 1 ảnh có bảng giá, 1 video 15 giây có lời nói. 22 câu hỏi có đáp án, mỗi câu hỏi **có dấu và không dấu** (44 lượt). "Đúng" = trong 3 kết quả đầu có mục chứa **nguyên văn** chuỗi đáp án (tên riêng, con số, địa chỉ); "đúng nguồn" = mục đó dẫn về đúng file (video: đúng khoảng `mm:ss–mm:ss`).

| Kho                             | top-1         | top-3            | đúng nguồn       |
| ------------------------------- | ------------- | ---------------- | ---------------- |
| 8 nguồn, ~13 mục                | 90,9% (40/44) | **100%** (44/44) | **100%** (44/44) |
| + 150 mục "gây nhiễu" (163 mục) | 77,3% (34/44) | 77,3% (34/44)    | 77,3% (34/44)    |

Có dấu và không dấu **bằng nhau** (cả hai bảng). Tên riêng ("Nguyễn Thị Thu Hà"), con số ("1.250.000đ", "150.000.000đ"), địa chỉ ("12 Nguyễn Huệ, Q.1, TP. Hồ Chí Minh") nằm nguyên văn trong mục; tách đoạn không cắt giữa câu và không tách "TP. Hồ Chí Minh", "Q.1", "3.5", "Nguyễn V. An", "ThS. …" (test riêng).

**Cái bộ kiểm này KHÔNG đo — đừng đọc số trên như chất lượng thật:**

- Ảnh và khung hình video do một "nhà tiên tri" trả lời **đúng đáp án có sẵn**, phụ đề do `whisper-cli` giả → đo đường ống (tách đoạn, ghi mục, duyệt, tìm, dẫn nguồn), **không đo** việc đọc ảnh / nghe tiếng Việt của model thật.
- Kho nhỏ nên số 100% dễ. Biến thể có nhiễu cố tình dùng 150 chi nhánh **cùng từ vựng, khác số liệu**; 5 câu sai đều là câu chung chung ("Đổi trả trong bao nhiêu ngày?", "Hotline?", "Quán mở cửa lúc mấy giờ?"…) mà 150 mục nhiễu cũng trả lời được — tức câu hỏi mơ hồ theo cách dựng, nhưng cũng cho thấy **tìm từ khoá (FTS5, OR + bm25) không phân biệt được các bản ghi gần giống nhau** và **không có ngưỡng liên quan**: câu hỏi không có đáp án trong kho vẫn trả về mục "gần nhất", không biết nói "không có".
- Chỉ tìm từ khoá. Tìm theo nghĩa chưa đo bằng model thật nên không đưa vào số liệu; PDF có dấu tiếng Việt (phụ thuộc font) và phụ đề tiếng Việt chưa kiểm.

## Hệ quả

- Agent có kho tri thức có nguồn; người dùng nắm quyền duyệt, sửa, gỡ và hoàn tác.
- Plugin phụ thuộc chương trình ngoài người dùng tự cài (ffmpeg, whisper-cli) — đổi lại không đóng nhị phân GPL và không có đường để plugin tự chạy mã tải về.
- `main.js` 2,4 MB commit vào repo: chấp nhận được; nếu nặng thêm thì chuyển sang bước build lúc đóng gói.
- Hộp duyệt chung của app ("Bộ nhớ") cũng đếm các đề xuất của Knowledge Base (cùng một hộp duyệt); duyệt ở màn hình Knowledge Base thì tiện hơn vì có đối chiếu nguồn.
