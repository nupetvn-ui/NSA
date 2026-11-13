# ADR-0009: Nguồn model qua API key — kho khoá, adapter `api`, cấp key cho CLI, chọn model theo việc

- Trạng thái: Chấp nhận
- Ngày: 2026-11-13
- Bổ sung cho [ADR-0005](0005-o-cam-chinh-sach-nhat-ky-danh-tinh.md), [ADR-0006](0006-dieu-phoi-nhieu-agent-va-ba-tang.md)

## Bối cảnh

Giai đoạn 1b của [PLAN.md](../PLAN.md) (mục "Nguồn model qua API key"): người dùng dán API key của một hãng (Google AI Studio, DeepSeek, …) là chat được; việc nền chạy bằng model rẻ; hãng lỗi thì tự chuyển model dự phòng. Key bị lộ là mất tiền thật.

## Quyết định

### File dữ liệu nhà cung cấp (`packages/providers/src/catalog.json`)

- 15 hãng trong bảng của plan + mục "Tự khai báo". Mỗi hãng: chuẩn API, địa chỉ theo chuẩn OpenAI / Anthropic, model (loại việc hợp, giá USD / 1 triệu token, nhìn ảnh, mức gọi tool), thông tin dữ liệu (nơi đặt máy chủ, có dùng để huấn luyện không, gói miễn phí / trả tiền, cảnh báo), cặp CLI ghép được, và **danh sách trang tài liệu chính thức** đã đọc.
- Mọi giá trị lấy từ tài liệu chính thức đọc ngày 12/11/2026. Chỗ tài liệu không ghi hoặc không đọc được để `null` và giao diện hiện "Chưa xác minh" (ví dụ giá Qwen, Kimi; chính sách huấn luyện của xAI, Kimi, GLM, MiniMax, Together).
- Tách khỏi mã: NSA đọc `%APPDATA%\NSA\provider-catalog.json` nếu file đó hợp lệ và có `version` mới hơn bản đóng gói (kiểm cấu trúc; địa chỉ `http` chỉ cho máy cục bộ). Cơ chế tải file về tự động chưa làm — sẽ dùng chung kênh tải adapter.
- `toolCalling`: `stable` (NSA đã chạy thật gọi tool / sửa file với model này — hiện chỉ model Claude, vì Claude Code đã chạy thật ở giai đoạn 1), `documented` (tài liệu nói hỗ trợ, chưa thử), `none`.

### Kho khoá

- Dùng **Electron `safeStorage`** (Windows: DPAPI theo tài khoản người dùng; macOS: Keychain; Linux: libsecret). Không thêm thư viện native (keytar đã ngừng bảo trì).
- `%APPDATA%\NSA\secrets.json` chỉ chứa bản mã (base64). `safeStorage` không dùng được thì **không lưu** (không bao giờ lưu dạng thô); hãng chạy trên máy vẫn dùng được.
- Key không nằm trong `providers.json` (cài đặt), nhật ký, lịch sử chat, lịch sử phiên API, sổ chi phí, thông báo lỗi, hay bất cứ gì gửi lên giao diện. Giao diện chỉ thấy `••••` + bốn ký tự cuối. Key đi một chiều renderer → main (`providers:setKey`) và ô nhập được xoá ngay.
- Phòng nhiều lớp: adapter che key trong mọi sự kiện; văn bản stream được che **theo luồng** (giữ lại phần đuôi có thể là đầu của key — test quét key đã bắt được lỗi key bị cắt qua nhiều mẩu stream); nhật ký và file cuộc trò chuyện được che thêm một lần trước khi ghi.
- **Test quét key** (`apps/desktop/src/main/keyscan.test.ts`): máy chủ giả cố tình in lại key trong trả lời và lỗi; chạy chat, chuyển agent khi hãng lỗi, CLI được cấp key, việc nền, nút Kiểm tra; rồi quét mọi file app ghi ra và mọi thứ gửi lên giao diện, ở cả dạng thô, base64, URL-encoded.

### Adapter `api` (`packages/adapters/api`)

- Gọi thẳng bằng `fetch` + đọc SSE, không dùng SDK của hãng: **chuẩn OpenAI** (`POST /chat/completions`, `stream_options.include_usage`; máy chủ không nhận `stream_options` thì tự thử lại không có nó) và **chuẩn Anthropic** (`POST /v1/messages`, token lấy từ `message_start` và `message_delta` — số trong `message_delta` là cộng dồn).
- Gemini đi qua địa chỉ tương thích OpenAI (`generativelanguage.googleapis.com/v1beta/openai`) — tài liệu chính thức xác nhận stream, gọi tool, `include_usage`, embedding (trang ghi "beta").
- Theo đúng hợp đồng adapter: `session` (NSA tự giữ lịch sử theo mã phiên vì API không nhớ), `text` từng mẩu, `usage` kèm chi phí ước tính, `error` (`auth` cho 401/403; còn lại `cli` kèm lời giải thích — 402/429 là "hết hạn mức"), luôn kết thúc bằng một `done`; huỷ bằng `AbortController`. Qua `runContract` (thêm chế độ `transport: 'http'`: bước resume kiểm lịch sử được gửi lại thay cho mã phiên trong tham số dòng lệnh).
- `editFiles` luôn `false`. Vòng lặp gọi tool có sẵn qua interface `ToolExecutor` (danh sách tool + chạy tool), chỉ bật khi được cấp executor **và** model `stable`. Giai đoạn 3 nối executor với MCP gateway; mỗi lần chạy tool phải qua `Policy` (`agent.tool`).
- Header `anthropic-version: 2023-06-01`.

### Cấp key cho CLI sẵn có

NSA đặt biến môi trường cho **từng lượt chạy** (`RunOptions.env`), không sửa cấu hình toàn cục của CLI. Đã chạy CLI thật trỏ vào máy chủ giả:

| CLI                 | Cách                                                                                                                                                                                                                                                 | Kết quả thử                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode 1.19.5     | `OPENCODE_CONFIG_CONTENT` khai báo nhà cung cấp `nsa-<hãng>` (`npm: @ai-sdk/openai-compatible`, `options.baseURL`, `options.apiKey: "{env:NSA_PROVIDER_KEY}"`), key trong biến `NSA_PROVIDER_KEY`, `-m nsa-<hãng>/<model>`. Gộp với cấu hình sẵn có. | **Chạy thật với máy chủ giả**: gửi đúng key; không ghi key vào thư mục dữ liệu của OpenCode. Dùng được cho mọi hãng có địa chỉ chuẩn OpenAI. Tài liệu OpenCode hiện tại mô tả lược đồ mới (`providers` / `package` / `settings`); bản 1.19.5 trên máy chạy với lược đồ cũ — cần theo dõi khi OpenCode cập nhật.                                                                  |
| Claude Code 2.1.322 | `CLAUDE_CONFIG_DIR` riêng của NSA (`%APPDATA%\NSA\cli-homes\claude\<hãng>`) + `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (hãng khác) hoặc `ANTHROPIC_API_KEY` (Anthropic) + `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`.                      | **Phát hiện khi thử**: chỉ đặt `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (hay `ANTHROPIC_API_KEY`) thì Claude Code **vẫn gửi token đăng nhập gói thuê bao của người dùng** tới địa chỉ mới — tức là lộ token cho hãng khác. Với `CLAUDE_CONFIG_DIR` riêng (không có đăng nhập) thì gửi đúng key NSA cấp; thư mục đó không chứa key. Chỉ ghép với hãng mà tài liệu hướng dẫn. |
| Codex               | Chỉ OpenAI: `CODEX_API_KEY` (tài liệu: dùng cho một lần `codex exec`), `CODEX_HOME` riêng, `-c model="…"`.                                                                                                                                           | **Chưa thử** (không có máy chủ giả nói Responses API; Codex chỉ nhận `wire_api = "responses"`).                                                                                                                                                                                                                                                                                  |

- Thư mục cấu hình riêng nghĩa là CLI chạy bằng key **không** dùng cài đặt / móc / MCP trong cấu hình cá nhân của người dùng. Móc chặn lệnh của NSA (ADR-0007) vẫn gắn qua `--settings` / `OPENCODE_CONFIG_CONTENT` như thường.
- Model chưa `stable` thì CLI được cấp key luôn chạy **chỉ đọc**, kể cả khi cuộc trò chuyện cho sửa file, và bộ định tuyến không chọn nó cho việc sửa file (năng lực `editFiles` = false).
- Không có tầng dự phòng PTY cho CLI được cấp key (tầng đó không nhận biến môi trường của lượt).

### Chọn model theo việc, dự phòng, chính sách

- Năm loại việc: việc chính, việc nền, nhìn ảnh/video, embedding, kênh chat. Mỗi loại: model chính + dự phòng do người dùng chọn, rồi NSA **tự thêm** model hợp loại việc của các hãng đã có key, **rẻ trước** — nên việc nền mặc định chạy bằng model rẻ nhất.
- `ModelTaskRunner` (lõi) chạy việc theo chuỗi: mỗi ứng viên hỏi `Policy` với hành động mới **`model.use`** (hãng, model, loại việc, có tính tiền không); hãng lỗi / hết hạn mức thì chuyển ứng viên kế tiếp, báo người dùng, ghi `AuditLog` mục `fallback` (`kind: 'model'`).
- Chat: model API là agent trong danh sách chat (`api:<hãng>/<model>`; CLI được cấp key là `<cli>+<hãng>/<model>`). `withModelPolicy` hỏi thêm `model.use` cho mỗi lượt chạy agent dùng hãng — bản Doanh nghiệp chặn hãng ngoài danh sách được phép tại đây. `ChatService` nhận `fallbackOrder`: hãng lỗi thì đi theo chuỗi model của việc chính trước, rồi mới tới agent khác.

### Chi phí

- Token lấy từ sự kiện `usage` (chỉ ghi số cuối mỗi lượt vì một số CLI phát số cộng dồn), chi phí ước tính từ bảng giá trong file dữ liệu. Sổ ghi mỗi tháng một file `%APPDATA%\NSA\usage\YYYY-MM.json` (chỉ số đếm).
- Hạn mức tháng tự đặt; cảnh báo khi đạt ngưỡng (mặc định 80%) và khi vượt — hiện trên thanh bên và ghi `AuditLog` mục `budget`. Tuỳ chọn "dừng khi vượt" chặn model trả phí qua ổ cắm chính sách.
- Giá giờ cao điểm (DeepSeek) được dùng khi ước tính để không báo thấp.

## Hệ quả

- Thêm hãng mới: sửa file dữ liệu (không cần ra bản app) hoặc người dùng tự khai báo địa chỉ + tên model.
- Mọi đường chọn hãng đều qua `Policy` (`model.use`), nên giai đoạn 9 chỉ cần cắm chính sách và key dùng chung.

## Đã kiểm

- `pnpm test`: adapter `api` qua `runContract` ở cả hai chuẩn, stream, đếm token, lỗi 401 / 429, vòng lặp gọi tool, bộ che theo luồng; chuỗi model theo việc; chuyển dự phòng trong chat và việc nền; chính sách chặn hãng; test quét key.
- `NSA_LIVE_CONTRACT=1 pnpm test:live` (`pairing.test.ts`): OpenCode 1.19.5 và Claude Code 2.1.322 **thật** trỏ vào máy chủ giả — cả hai gửi đúng key NSA cấp, trả lời được, thư mục cấu hình riêng không chứa key.
- **Bản đóng gói** (`win-unpacked\NSA.exe`, thư mục dữ liệu tạm, điều khiển qua cổng gỡ lỗi, máy chủ giả): `safeStorage` dùng được; `secrets.json` chỉ có bản mã DPAPI; mở lại app vẫn giải mã được và gửi đúng key; dán key → model hiện trong danh sách agent; chat với model giả "hết hạn mức" (429) → tự chuyển sang model dự phòng và hiện thông báo trong lượt; "Chạy thử" việc nền → chạy bằng model rẻ nhất; vượt hạn mức → cảnh báo trên thanh bên; quét thư mục dữ liệu sau hai lần chạy không thấy key.

## Chưa làm / chưa kiểm

- **Chưa chạy với hãng thật nào** (không có key). Mọi đường gọi API, CLI được cấp key, chuyển dự phòng, chi phí mới chạy với máy chủ giả nói đúng chuẩn. Máy phát triển không có Ollama / LM Studio.
- Codex được cấp key chưa thử. Tự tải file dữ liệu mới chưa làm. Ảnh đính kèm trong chat chưa có (adapter đã hỗ trợ ảnh trong tin nhắn, giao diện chat chưa gửi ảnh). Vòng lặp gọi tool chưa nối MCP gateway (giai đoạn 3).
